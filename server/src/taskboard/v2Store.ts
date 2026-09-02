import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type {
  TaskBoardChange, TaskBoardComment, TaskBoardExecutionContextInput, TaskBoardExecutionContextResponse,
  TaskBoardIntegrationBatchCreateInput, TaskBoardIntegrationSource, TaskBoardMember, TaskBoardMemberPatchInput,
  TaskBoardRepositoryConfig, TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import { rowToBoard } from './boardFields.js';
import { loadExecutionIntegrationAgent } from './executionIntegrationAgentContext.js';
import type { RepositoryProvider } from './repositoryProvider.js';
import { rowToIntegrationSource } from './integrationSourceMapper.js';
import { integrationAgentTableNames } from './integrationAgentSchema.js';
import { resolveExecutionContextWorkflowContract } from './executionContextContract.js';
import { fenceTaskExecutions } from './workflow/commandService.js';
import {
  commentExecutionJoin,
  rowToComment,
  rowToExecution,
  rowToTask,
  toIso,
  visibleCommentPredicate,
} from './storeHelpers.js';
import {
  TaskboardConflictError,
  TaskboardNotFoundError,
  TaskboardPermissionError,
  TaskboardValidationError,
  type TaskboardIdentity,
} from './types.js';

export interface TaskboardV2StoreOptions {
  pool: { connect(): Promise<PoolClient>; query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
  boardsTable: string;
  tasksTable: string;
  commentsTable: string;
  executionsTable: string;
  membersTable: string;
  changesTable: string;
  integrationLanesTable: string;
  integrationSourcesTable: string;
  mergeAuthorizationsTable: string;
  mergeOperationsTable: string;
  blockEpisodesTable: string;
  integrationTriggerOutboxTable: string;
  remediationAttemptsTable: string;
  cancellationOutboxTable: string;
  repositoryProvider?: RepositoryProvider;
}

const SORT_GAP = 1024;

export async function listBoardMembers(
  options: TaskboardV2StoreOptions,
  identity: TaskboardIdentity,
  boardId: string,
): Promise<TaskBoardMember[]> {
  const client = await options.pool.connect();
  try {
    await requireBoardAccess(options, client, identity, boardId, 'maintainer', false);
    const result = await client.query(
      `SELECT board_id, user_id, role, created_at, updated_at
         FROM ${options.membersTable}
        WHERE board_id=$1
        ORDER BY created_at, user_id`,
      [boardId],
    );
    return result.rows.map(rowToMember);
  } finally {
    client.release();
  }
}

export async function upsertBoardMember(
  options: TaskboardV2StoreOptions,
  identity: TaskboardIdentity,
  boardId: string,
  input: TaskBoardMemberPatchInput,
): Promise<TaskBoardMember> {
  return withTransaction(options, async (client) => {
    await requireBoardAccess(options, client, identity, boardId, 'owner', true);
    const result = await client.query(
      `INSERT INTO ${options.membersTable} (board_id, user_id, role)
       VALUES ($1,$2,$3)
       ON CONFLICT (board_id,user_id) DO UPDATE
         SET role=EXCLUDED.role, updated_at=now()
       RETURNING board_id, user_id, role, created_at, updated_at`,
      [boardId, input.userId, input.role],
    );
    await appendBoardChange(options, client, boardId, 'member.upserted', 'user', identity.ownerUserId, {
      userId: input.userId,
      role: input.role,
    });
    return rowToMember(result.rows[0]!);
  });
}

export async function removeBoardMember(
  options: TaskboardV2StoreOptions,
  identity: TaskboardIdentity,
  boardId: string,
  userId: string,
): Promise<void> {
  await withTransaction(options, async (client) => {
    await requireBoardAccess(options, client, identity, boardId, 'owner', true);
    const result = await client.query(
      `DELETE FROM ${options.membersTable} WHERE board_id=$1 AND user_id=$2 RETURNING role`,
      [boardId, userId],
    );
    if (result.rows[0]) {
      await appendBoardChange(options, client, boardId, 'member.removed', 'user', identity.ownerUserId, {
        userId,
        role: result.rows[0].role,
      }, true);
    }
  });
}

export async function createIntegrationBatch(
  options: TaskboardV2StoreOptions,
  identity: TaskboardIdentity,
  boardId: string,
  input: TaskBoardIntegrationBatchCreateInput,
  source: 'scheduled_policy' | 'on_ready_policy' | 'manual_batch' = 'manual_batch',
): Promise<TaskBoardTask> {
  const uniqueTaskIds = [...new Set(input.deliveryTaskIds)];
  if (!uniqueTaskIds.length) {
    throw new TaskboardValidationError('Integration batch requires at least one task');
  }
  return withTransaction(options, async (client) => {
    const board = await requireBoardAccess(
      options,
      client,
      identity,
      boardId,
      source === 'manual_batch' ? 'maintainer' : 'owner',
      true,
    );
    if (board.archived_at) throw new TaskboardValidationError('Archived boards are read-only');
    if (Number(board.version) !== input.expectedBoardVersion) {
      throw new TaskboardConflictError(rowToBoard(board, identity.ownerUserId));
    }
    const repository = jsonObject(board.repository) as TaskBoardRepositoryConfig | undefined;
    const policy = jsonObject(board.integration_policy) as {
      enabled?: boolean;
      revision?: string;
      workflowVersion?: 3;
      trigger?: { mode?: string; allowedRoles?: string[] };
      batch?: { maxTasks?: number };
      execution?: { mergeMethod?: 'merge' | 'squash' | 'rebase' };
      [key: string]: unknown;
    } | undefined;
    if (!repository?.repositoryId || !policy?.enabled || !policy.revision) {
      throw new TaskboardValidationError('Board integration policy is not enabled', 'TASKBOARD_INTEGRATION_DISABLED');
    }
    const workflowVersion = 3 as const;
    // Agent-first integrations run through the generic durable execution coordinator;
    // they do not depend on the retired Candidate worker heartbeat.
    if (workflowVersion === 3 && !repository.baseBranch) {
      throw new TaskboardValidationError('Workflow v3 requires a repository base branch', 'TASKBOARD_REPOSITORY_REQUIRED');
    }
    if (source !== 'manual_batch' && policy.trigger?.mode !== (source === 'scheduled_policy' ? 'scheduled' : 'on_ready')) {
      throw new TaskboardValidationError('Integration trigger no longer matches board policy', 'TASKBOARD_POLICY_CHANGED');
    }
    if (source === 'manual_batch') {
      const role = String(board.board_role ?? 'viewer');
      if (policy.trigger?.mode !== 'manual' || !policy.trigger.allowedRoles?.includes(role)) {
        throw new TaskboardPermissionError('Board policy does not allow manual integration for this role');
      }
    }
    if (uniqueTaskIds.length > Math.max(1, Number(policy.batch?.maxTasks ?? 20))) {
      throw new TaskboardValidationError('Integration batch exceeds configured maximum', 'TASKBOARD_BATCH_TOO_LARGE');
    }
    const sources = await client.query(
      `SELECT t.*
         FROM ${options.tasksTable} t
        WHERE t.board_id=$1 AND t.id=ANY($2::text[])
        ORDER BY
          CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
          t.updated_at, t.identifier
        FOR UPDATE OF t`,
      [boardId, uniqueTaskIds],
    );
    if (sources.rows.length !== uniqueTaskIds.length) {
      throw new TaskboardValidationError('One or more integration source tasks were not found');
    }
    for (const row of sources.rows) {
      if (row.kind !== 'delivery' || row.status !== 'ready_to_merge'
        || (!row.branch && !row.provider_pull_request_id)) {
        throw new TaskboardValidationError(
          `Task ${String(row.identifier)} is not a usable delivery source`,
          'TASKBOARD_INTEGRATION_SOURCE_INVALID',
        );
      }
    }
    const duplicate = await client.query(
      `SELECT s.delivery_task_id
         FROM ${options.integrationSourcesTable} s
        WHERE s.state NOT IN ('merged','canceled')
          AND s.delivery_task_id=ANY($1::text[])
        LIMIT 1`,
      [uniqueTaskIds],
    );
    if (duplicate.rows[0]) {
      throw new TaskboardValidationError(
        'A delivery task or pull request already belongs to an active integration batch',
        'TASKBOARD_INTEGRATION_SOURCE_DUPLICATE',
      );
    }
    const nextNumber = await client.query(
      `UPDATE ${options.boardsTable}
          SET next_task_number=next_task_number+1, version=version+1, updated_at=now()
        WHERE id=$1
        RETURNING next_task_number-1 AS task_number`,
      [boardId],
    );
    const tail = await client.query(
      `SELECT COALESCE(MAX(sort_order),0) AS max_sort_order
         FROM ${options.tasksTable}
        WHERE board_id=$1 AND status='in_progress' AND archived_at IS NULL`,
      [boardId],
    );
    const integrationTaskId = randomUUID();
    const title = `集成合并：${sources.rows.map((row) => String(row.identifier)).join('、')}`;
    await client.query(
      `INSERT INTO ${options.tasksTable}
         (id, board_id, identifier, kind, title, description, status, priority, labels,
          sort_order, creator_user_id, creator_name, workflow_version, version)
       VALUES ($1,$2,$3,'integration',$4,$5,'in_progress','high',ARRAY['integration']::text[],$6,$7,$8,$9,1)`,
      [
        integrationTaskId,
        boardId,
        `TASK-${Number(nextNumber.rows[0]!.task_number)}`,
        title,
        '由一个持久 Integration Agent 自主组合、合并并清理本批次交付来源。',
        Number(tail.rows[0]?.max_sort_order ?? 0) + SORT_GAP,
        identity.ownerUserId,
        identity.displayName?.trim() || identity.username,
        workflowVersion,
      ],
    );
    const frozenSources: Array<{ integrationSourceId: string }> = [];
    for (const [index, row] of sources.rows.entries()) {
      const integrationSourceId = randomUUID();
      await client.query(
        `INSERT INTO ${options.integrationSourcesTable}
           (id, integration_task_id, delivery_task_id, repository_id, provider_pull_request_id,
            frozen_head_oid, source_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          integrationSourceId, integrationTaskId, row.id, repository.repositoryId,
          row.provider_pull_request_id, row.head_oid, index,
        ],
      );
      frozenSources.push({ integrationSourceId });
      await appendChange(options, client, String(row.id), 'integration.source_added', 'system', identity.ownerUserId, {
        integrationTaskId,
        order: index,
      });
    }
    // GitHub is the only code authority. Persist only the durable Agent rendezvous
    // record; source PR heads/reviews are re-read by the Agent before every action.
    const { agentsTable } = integrationAgentTableNames(options.integrationSourcesTable);
    await client.query(
      `INSERT INTO ${agentsTable}
        (integration_task_id,delivery_source_ids,repository_id,status)
       VALUES ($1,$2::jsonb,$3,'active')`,
      [integrationTaskId, JSON.stringify(frozenSources.map((source) => source.integrationSourceId)),
        repository.repositoryId],
    );
    await appendChange(options, client, integrationTaskId, 'integration.created', 'system', identity.ownerUserId, {
      source,
      deliveryTaskIds: sources.rows.map((row) => String(row.id)),
      policyRevision: policy.revision,
    });
    return loadTask(options, client, integrationTaskId);
  });
}

export async function cancelIntegrationTask(
  options: TaskboardV2StoreOptions,
  identity: TaskboardIdentity,
  taskId: string,
  input: { expectedVersion: number; reason?: string },
): Promise<TaskBoardTask> {
  return withTransaction(options, async (client) => {
    const loaded = await loadAccessibleTaskAndBoard(options, client, identity, taskId, true);
    const role = String(loaded.board.board_role ?? 'viewer') as 'viewer' | 'editor' | 'maintainer' | 'owner';
    if (roleRank(role) < roleRank('maintainer')) {
      throw new TaskboardPermissionError('Taskboard role cannot cancel integration tasks');
    }
    if (loaded.task.kind !== 'integration') {
      throw new TaskboardValidationError('Only integration tasks can be canceled');
    }
    if (loaded.task.status === 'canceled') return loaded.task;
    if (loaded.task.version !== input.expectedVersion) throw new TaskboardConflictError(loaded.task);
    if (loaded.task.status === 'done') {
      throw new TaskboardValidationError('Integration task is already terminal');
    }
    if ((loaded.task.workflowVersion ?? 2) === 3) {
      const { agentsTable } = integrationAgentTableNames(options.integrationSourcesTable);
      const agent = await client.query(
        `SELECT repository_id FROM ${agentsTable} WHERE integration_task_id=$1 FOR UPDATE`, [taskId],
      );
      if (!agent.rows[0]) {
        throw new TaskboardValidationError(
          'Integration task has no Agent rendezvous record',
          'TASKBOARD_INTEGRATION_AGENT_REQUIRED',
        );
      }
      await fenceTaskExecutions(options, client, [taskId], 'integration_canceled');
      const reason = input.reason?.trim() || 'Integration task canceled by user';
      await client.query(
        `UPDATE ${agentsTable} SET status='canceled',updated_at=now() WHERE integration_task_id=$1`, [taskId],
      );
      await client.query(
        `UPDATE ${options.tasksTable}
            SET status='canceled',completed_at=NULL,next_action='none',version=version+1,updated_at=now()
          WHERE id=$1 AND workflow_version=3`, [taskId],
      );
      await client.query(
        `UPDATE ${options.integrationSourcesTable}
            SET state='canceled',last_error=$2,updated_at=now()
          WHERE integration_task_id=$1 AND state<>'merged' AND merged_commit_oid IS NULL`, [taskId, reason],
      );
      await client.query(
        `UPDATE ${options.integrationLanesTable}
            SET active_integration_task_id=NULL,lease_id=NULL,epoch=epoch+1,updated_at=now()
          WHERE repository_id=$1 AND active_integration_task_id=$2`,
        [String(agent.rows[0].repository_id), taskId],
      );
      await appendChange(options, client, taskId, 'integration.agent.canceled', 'user', identity.ownerUserId, { reason }, true);
      return loadTask(options, client, taskId);
    }
    const uncertain = await client.query(
      `SELECT 1
         FROM ${options.mergeOperationsTable} o
         JOIN ${options.integrationSourcesTable} s ON s.id=o.integration_source_id
        WHERE s.integration_task_id=$1 AND o.state IN ('executing','unknown') LIMIT 1`,
      [taskId],
    );
    if (uncertain.rows[0]) {
      throw new TaskboardValidationError(
        'Provider merge result must be reconciled before cancellation',
        'TASKBOARD_PROVIDER_RESULT_UNKNOWN',
      );
    }
    await fenceTaskExecutions(options, client, [taskId], 'integration_canceled');
    await client.query(
      `UPDATE ${options.tasksTable}
          SET status='canceled', completed_at=NULL, version=version+1, updated_at=now()
        WHERE id=$1`,
      [taskId],
    );
    await client.query(
      `UPDATE ${options.integrationSourcesTable}
          SET state='canceled', last_error=$2, updated_at=now()
        WHERE integration_task_id=$1 AND state<>'merged'
          AND merged_commit_oid IS NULL AND provider_receipt_id IS NULL`,
      [taskId, input.reason?.trim() || 'Integration task canceled by user'],
    );
    await client.query(
      `UPDATE ${options.mergeAuthorizationsTable} SET revoked_at=now()
        WHERE integration_task_id=$1 AND revoked_at IS NULL`,
      [taskId],
    );
    const repository = jsonObject(loaded.board.repository) as { repositoryId?: string } | undefined;
    if (repository?.repositoryId) {
      await client.query(
        `UPDATE ${options.integrationLanesTable}
            SET active_integration_task_id=NULL, lease_id=NULL, epoch=epoch+1, updated_at=now()
          WHERE repository_id=$1 AND active_integration_task_id=$2`,
        [repository.repositoryId, taskId],
      );
    }
    await appendChange(options, client, taskId, 'integration.canceled', 'user', identity.ownerUserId, {
      reason: input.reason?.trim() || undefined,
    }, true);
    return loadTask(options, client, taskId);
  });
}

export async function listIntegrationSources(
  options: TaskboardV2StoreOptions,
  identity: TaskboardIdentity,
  integrationTaskId: string,
): Promise<TaskBoardIntegrationSource[]> {
  const client = await options.pool.connect();
  try {
    const task = await loadAccessibleTask(options, client, identity, integrationTaskId, false);
    if (task.kind !== 'integration') {
      throw new TaskboardValidationError('Task is not an integration task');
    }
    const result = await client.query(
      `SELECT s.*,d.identifier AS delivery_task_identifier,d.title AS delivery_task_title
         FROM ${options.integrationSourcesTable} s
         JOIN ${options.tasksTable} d ON d.id=s.delivery_task_id
        WHERE s.integration_task_id=$1
        ORDER BY s.source_order, s.created_at`,
      [integrationTaskId],
    );
    return result.rows.map(rowToIntegrationSource);
  } finally {
    client.release();
  }
}

export async function getExecutionContextV2(
  options: TaskboardV2StoreOptions,
  identity: TaskboardIdentity,
  taskId: string,
  input: TaskBoardExecutionContextInput = {},
): Promise<TaskBoardExecutionContextResponse> {
  const client = await options.pool.connect();
  try {
    const loaded = await loadAccessibleTaskAndBoard(options, client, identity, taskId, false);
    const include = new Set(input.include ?? ['task', 'board', 'comments', 'executions', 'integrationSources']);
    const latestExecutionResult = await client.query(
      `SELECT e.*, t.workflow_epoch
         FROM ${options.executionsTable} e
         JOIN ${options.tasksTable} t ON t.id=e.task_id
        WHERE e.task_id=$1 AND ($2::text IS NULL OR e.run_id=$2)
        ORDER BY e.created_at DESC LIMIT 1`,
      [taskId, input.runId ?? null],
    );
    if (input.runId && !latestExecutionResult.rows[0]) {
      throw new TaskboardNotFoundError('Execution does not belong to this task');
    }
    const latestExecution = latestExecutionResult.rows[0] ? rowToExecution(latestExecutionResult.rows[0]) : undefined;
    const activeExecution = latestExecution
      && ['queued', 'running', 'waiting_user', 'waiting_approval'].includes(latestExecution.status)
      ? latestExecution
      : undefined;
    const contract = await resolveExecutionContextWorkflowContract(
      options, client, loaded.task, activeExecution?.purpose,
    );
    const asOfResult = await client.query(
      `SELECT COALESCE(MAX(seq),0)::text AS seq FROM ${options.changesTable} WHERE task_id=$1`,
      [taskId],
    );
    const asOfSeq = String(asOfResult.rows[0]?.seq ?? '0');
    const history = input.history ?? { mode: 'auto' as const };
    const limit = Math.min(500, Math.max(1, history.limit ?? 100));
    const cursor = history.cursor?.trim() || undefined;
    if (cursor && !/^\d+$/.test(cursor)) {
      throw new TaskboardValidationError('Invalid task context cursor');
    }
    const afterSeq = history.mode === 'full' ? '0' : cursor ?? '0';
    const changeRows = include.has('activity') || history.mode === 'full' || history.mode === 'delta' || Boolean(cursor)
      ? await client.query(
        `SELECT * FROM ${options.changesTable}
          WHERE task_id=$1 AND seq>$2::bigint AND seq<=$3::bigint
          ORDER BY seq LIMIT $4`,
        [taskId, afterSeq, asOfSeq, limit + 1],
      )
      : { rows: [] as Record<string, unknown>[] };
    const page = changeRows.rows.slice(0, limit);
    const comments = include.has('comments')
      ? await client.query(
        `SELECT c.*, comment_execution.comment_session_id, comment_execution.comment_execution_id,
                comment_execution.comment_execution_purpose
           FROM ${options.commentsTable} c
          ${commentExecutionJoin(options.changesTable, options.executionsTable)}
          WHERE c.task_id=$1 AND ${visibleCommentPredicate('c', options.changesTable)}
          ORDER BY c.created_at,c.id`,
        [taskId],
      )
      : undefined;
    const executions = include.has('executions')
      ? await client.query(
        `SELECT e.* FROM ${options.executionsTable} e
          WHERE e.task_id=$1 ORDER BY e.created_at,e.id`,
        [taskId],
      )
      : undefined;
    const sources = include.has('integrationSources') && loaded.task.kind === 'integration'
      ? await client.query(`SELECT * FROM ${options.integrationSourcesTable} WHERE integration_task_id=$1 ORDER BY source_order`, [taskId])
      : undefined;
    const policy = jsonObject(loaded.board.integration_policy) as { revision?: string } | undefined;
    const { prompt: _prompt, stagePrompts: _stagePrompts, ...contextBoard } = rowToBoard(
      loaded.board,
      identity.ownerUserId,
    );
    return {
      board: contextBoard,
      task: loaded.task,
      ...(comments ? { comments: comments.rows.map(rowToComment) } : {}),
      ...(executions ? { executions: executions.rows.map(rowToExecution) } : {}),
      ...(sources ? { integrationSources: sources.rows.map(rowToIntegrationSource) } : {}),
      ...(include.has('integrationSources') && loaded.task.kind === 'integration' && loaded.task.workflowVersion === 3
        ? { integrationAgent: await loadExecutionIntegrationAgent(client, options.integrationSourcesTable, taskId) } : {}),
      ...(page.length ? { changes: page.map(rowToChange) } : {}),
      asOfSeq,
      ...(page.length && changeRows.rows.length > limit
        ? { nextCursor: String(page[page.length - 1]!.seq) }
        : {}),
      hasMore: changeRows.rows.length > limit,
      contract,
    };
  } finally {
    client.release();
  }
}

export async function appendBoardChange(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  boardId: string,
  changeType: string,
  actorType: TaskBoardChange['actorType'],
  actorId: string,
  payload: Record<string, unknown>,
  tombstone = false,
): Promise<void> {
  await client.query(
    `INSERT INTO ${options.changesTable}
       (board_id, resource_type, change_type, actor_type, actor_id, payload, tombstone)
     VALUES ($1,'board',$2,$3,$4,$5::jsonb,$6)`,
    [boardId, changeType, actorType, actorId, JSON.stringify(payload), tombstone],
  );
}

export async function appendTaskChange(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  taskId: string,
  changeType: string,
  actorType: 'user' | 'agent' | 'system',
  actorId: string,
  payload: Record<string, unknown>,
  tombstone = false,
): Promise<void> {
  await appendChange(options, client, taskId, changeType, actorType, actorId, payload, tombstone);
}

/** Existing ready sources are checked when policy activation has no specific transition task. */
export async function enqueueOnReadyTrigger(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  board: Record<string, unknown>,
  taskId?: string,
): Promise<void> {
  const policy = jsonObject(board.integration_policy) as {
    enabled?: boolean;
    revision?: string;
    trigger?: { mode?: string; debounceMs?: number };
  } | undefined;
  if (!policy?.enabled || policy.trigger?.mode !== 'on_ready' || !policy.revision) return;
  await client.query(
    `INSERT INTO ${options.integrationTriggerOutboxTable}
       (id, board_id, task_id, trigger_mode, policy_revision, available_at)
     SELECT $1,$2,$3,'on_ready',$4,now()+($5::bigint * interval '1 millisecond')
      WHERE $3::text IS NOT NULL OR EXISTS (
        SELECT 1 FROM ${options.tasksTable} task
         WHERE task.board_id=$2 AND task.kind='delivery' AND task.status='ready_to_merge'
           AND task.archived_at IS NULL
           AND task.provider_pull_request_id IS NOT NULL
           AND task.reviewed_subject_digest IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM ${options.integrationSourcesTable} source
              WHERE source.delivery_task_id=task.id AND source.state NOT IN ('merged','canceled')
           )
      )
     ON CONFLICT DO NOTHING`,
    [randomUUID(), board.id, taskId ?? null, policy.revision, Math.max(0, Number(policy.trigger.debounceMs ?? 0))],
  );
}

export async function requireBoardAccess(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  identity: TaskboardIdentity,
  boardId: string,
  minimumRole: 'viewer' | 'editor' | 'maintainer' | 'owner',
  forUpdate: boolean,
): Promise<Record<string, unknown>> {
  const result = await client.query(
    `SELECT b.*,
            CASE WHEN b.owner_user_id=$3 THEN 'owner' ELSE COALESCE(m.role,'viewer') END AS board_role
       FROM ${options.boardsTable} b
       LEFT JOIN ${options.membersTable} m ON m.board_id=b.id AND m.user_id=$3
      WHERE b.id=$1 AND b.tenant_id=$2
        AND (b.owner_user_id=$3 OR b.visibility='organization')
      ${forUpdate ? 'FOR UPDATE OF b' : ''}`,
    [boardId, identity.tenantId, identity.ownerUserId],
  );
  const row = result.rows[0];
  if (!row) throw new TaskboardNotFoundError('Board not found');
  const role = String(row.board_role) as 'viewer' | 'editor' | 'maintainer' | 'owner';
  if (roleRank(role) < roleRank(minimumRole)) throw new TaskboardPermissionError();
  return row;
}

export async function loadAccessibleTaskAndBoard(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  identity: TaskboardIdentity,
  taskId: string,
  forUpdate: boolean,
): Promise<{ task: TaskBoardTask; board: Record<string, unknown> }> {
  const result = await client.query(
    `SELECT t.*,
            b.id AS actual_board_id,
            b.owner_user_id AS board_owner_user_id,
            b.name AS board_name,
            b.description AS board_description,
            b.visibility AS board_visibility,
            b.prompt AS board_prompt,
            b.stage_prompts AS board_stage_prompts,
            b.model AS board_model,
            b.stage_models AS board_stage_models,
            b.repository AS board_repository,
            b.integration_policy AS board_integration_policy,
            b.version AS board_version,
            b.archived_at AS board_archived_at,
            b.created_at AS board_created_at,
            b.updated_at AS board_updated_at,
            CASE WHEN b.owner_user_id=$3 THEN 'owner' ELSE COALESCE(m.role,'viewer') END AS board_role,
            (SELECT count(*)::int FROM ${options.commentsTable} c WHERE c.task_id=t.id AND ${visibleCommentPredicate('c', options.changesTable)}) AS comment_count,
            COALESCE(
              (SELECT s.integration_task_id FROM ${options.integrationSourcesTable} s WHERE s.delivery_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1),
              (SELECT s.integration_task_id FROM ${options.remediationAttemptsTable} a JOIN ${options.integrationSourcesTable} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1)
            ) AS integration_task_id,
            COALESCE(
              (SELECT s.id FROM ${options.integrationSourcesTable} s WHERE s.delivery_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1),
              (SELECT s.id FROM ${options.remediationAttemptsTable} a JOIN ${options.integrationSourcesTable} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1)
            ) AS integration_source_id,
            COALESCE(
              (SELECT s.delivery_task_id FROM ${options.integrationSourcesTable} s WHERE s.delivery_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1),
              (SELECT s.delivery_task_id FROM ${options.remediationAttemptsTable} a JOIN ${options.integrationSourcesTable} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1)
            ) AS root_delivery_task_id,
            COALESCE(
              (SELECT s.state FROM ${options.integrationSourcesTable} s WHERE s.delivery_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1),
              (SELECT s.state FROM ${options.remediationAttemptsTable} a JOIN ${options.integrationSourcesTable} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1)
            ) AS integration_state
       FROM ${options.tasksTable} t
       JOIN ${options.boardsTable} b ON b.id=t.board_id
       LEFT JOIN ${options.membersTable} m ON m.board_id=b.id AND m.user_id=$3
      WHERE t.id=$1 AND b.tenant_id=$2
        AND (b.owner_user_id=$3 OR b.visibility='organization')
        AND t.deleted_at IS NULL
      ${forUpdate ? 'FOR UPDATE OF t' : ''}`,
    [taskId, identity.tenantId, identity.ownerUserId],
  );
  const row = result.rows[0];
  if (!row) throw new TaskboardNotFoundError('Task not found');
  const board = {
    id: row.actual_board_id,
    owner_user_id: row.board_owner_user_id,
    name: row.board_name,
    description: row.board_description,
    visibility: row.board_visibility,
    prompt: row.board_prompt,
    stage_prompts: row.board_stage_prompts,
    model: row.board_model,
    stage_models: row.board_stage_models,
    repository: row.board_repository,
    integration_policy: row.board_integration_policy,
    version: row.board_version,
    archived_at: row.board_archived_at,
    created_at: row.board_created_at,
    updated_at: row.board_updated_at,
    board_role: row.board_role,
  };
  return { task: rowToTask(row), board };
}

async function loadAccessibleTask(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  identity: TaskboardIdentity,
  taskId: string,
  forUpdate: boolean,
): Promise<TaskBoardTask> {
  return (await loadAccessibleTaskAndBoard(options, client, identity, taskId, forUpdate)).task;
}

export async function loadTask(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  taskId: string,
): Promise<TaskBoardTask> {
  const result = await client.query(
    `SELECT t.*,
            (SELECT count(*)::int FROM ${options.commentsTable} c WHERE c.task_id=t.id AND ${visibleCommentPredicate('c', options.changesTable)}) AS comment_count,
            COALESCE(
              (SELECT s.integration_task_id FROM ${options.integrationSourcesTable} s WHERE s.delivery_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1),
              (SELECT s.integration_task_id FROM ${options.remediationAttemptsTable} a JOIN ${options.integrationSourcesTable} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1)
            ) AS integration_task_id,
            COALESCE(
              (SELECT s.id FROM ${options.integrationSourcesTable} s WHERE s.delivery_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1),
              (SELECT s.id FROM ${options.remediationAttemptsTable} a JOIN ${options.integrationSourcesTable} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1)
            ) AS integration_source_id,
            COALESCE(
              (SELECT s.delivery_task_id FROM ${options.integrationSourcesTable} s WHERE s.delivery_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1),
              (SELECT s.delivery_task_id FROM ${options.remediationAttemptsTable} a JOIN ${options.integrationSourcesTable} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1)
            ) AS root_delivery_task_id,
            COALESCE(
              (SELECT s.state FROM ${options.integrationSourcesTable} s WHERE s.delivery_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1),
              (SELECT s.state FROM ${options.remediationAttemptsTable} a JOIN ${options.integrationSourcesTable} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1)
            ) AS integration_state
       FROM ${options.tasksTable} t WHERE t.id=$1 AND t.deleted_at IS NULL`,
    [taskId],
  );
  if (!result.rows[0]) throw new TaskboardNotFoundError('Task not found');
  return rowToTask(result.rows[0]);
}

export async function appendChange(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  taskId: string,
  changeType: string,
  actorType: 'user' | 'agent' | 'system',
  actorId: string,
  payload: Record<string, unknown>,
  tombstone = false,
): Promise<void> {
  await client.query(
    `INSERT INTO ${options.changesTable}
       (task_id, change_type, actor_type, actor_id, payload, tombstone)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [taskId, changeType, actorType, actorId, JSON.stringify(payload), tombstone],
  );
}

function rowToChange(row: Record<string, unknown>): TaskBoardChange {
  return {
    seq: String(row.seq),
    taskId: String(row.task_id),
    type: String(row.change_type),
    actorType: String(row.actor_type) as TaskBoardChange['actorType'],
    actorId: String(row.actor_id),
    payload: jsonObject(row.payload) ?? {},
    tombstone: row.tombstone === true,
    createdAt: toIso(row.created_at),
  };
}

function rowToMember(row: Record<string, unknown>): TaskBoardMember {
  return {
    boardId: String(row.board_id),
    userId: String(row.user_id),
    role: String(row.role) as TaskBoardMember['role'],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function roleRank(role: string): number {
  return role === 'owner' ? 4 : role === 'maintainer' ? 3 : role === 'editor' ? 2 : 1;
}

export async function withTransaction<T>(
  options: TaskboardV2StoreOptions,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await options.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
