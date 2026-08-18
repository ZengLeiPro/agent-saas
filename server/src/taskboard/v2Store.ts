import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type {
  TaskBoardChange,
  TaskBoardExecutionContextInput,
  TaskBoardExecutionContextResponse,
  TaskBoardIntegrationBatchCreateInput,
  TaskBoardIntegrationSource,
  TaskBoardMember,
  TaskBoardMemberPatchInput,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import { rowToBoard } from './boardFields.js';
import { rowToIntegrationSource } from './integrationSourceMapper.js';
import { resolveWorkflowContract } from './workflowContract.js';
import { rowToComment, rowToExecution, rowToTask, toIso } from './storeHelpers.js';
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
  resolutionsTable: string;
  remediationAttemptsTable: string;
  cancellationOutboxTable: string;
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
    const repository = jsonObject(board.repository) as { repositoryId?: string } | undefined;
    const policy = jsonObject(board.integration_policy) as {
      enabled?: boolean;
      revision?: string;
      trigger?: { mode?: string; allowedRoles?: string[] };
      batch?: { maxTasks?: number };
    } | undefined;
    if (!repository?.repositoryId || !policy?.enabled || !policy.revision) {
      throw new TaskboardValidationError('Board integration policy is not enabled', 'TASKBOARD_INTEGRATION_DISABLED');
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
    const lane = await client.query(
      `SELECT repository_id, active_integration_task_id, epoch
         FROM ${options.integrationLanesTable}
        WHERE repository_id=$1 AND board_id=$2
        FOR UPDATE`,
      [repository.repositoryId, boardId],
    );
    if (!lane.rows[0]) throw new TaskboardValidationError('Integration lane is missing');
    if (lane.rows[0].active_integration_task_id) {
      throw new TaskboardValidationError(
        'Repository already has an active integration task',
        'TASKBOARD_INTEGRATION_ACTIVE',
      );
    }
    const sources = await client.query(
      `SELECT t.*,
              (SELECT count(*)::int FROM ${options.commentsTable} c WHERE c.task_id=t.id) AS comment_count
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
      if (row.kind !== 'delivery' || row.status !== 'ready_to_merge') {
        throw new TaskboardValidationError(
          `Task ${String(row.identifier)} is not an eligible delivery task`,
          'TASKBOARD_INTEGRATION_SOURCE_INVALID',
        );
      }
      if (!row.provider_pull_request_id || !row.reviewed_subject_digest) {
        throw new TaskboardValidationError(
          `Task ${String(row.identifier)} has no reviewed pull request subject`,
          'TASKBOARD_INTEGRATION_SOURCE_UNREVIEWED',
        );
      }
    }
    const duplicate = await client.query(
      `SELECT s.delivery_task_id,s.provider_pull_request_id
         FROM ${options.integrationSourcesTable} s
        WHERE s.state NOT IN ('merged','canceled')
          AND (s.delivery_task_id=ANY($1::text[])
            OR (s.repository_id=$2 AND s.provider_pull_request_id=ANY($3::text[])))
        LIMIT 1`,
      [uniqueTaskIds, repository.repositoryId, sources.rows.map((row) => String(row.provider_pull_request_id))],
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
        WHERE board_id=$1 AND status='todo' AND archived_at IS NULL`,
      [boardId],
    );
    const integrationTaskId = randomUUID();
    const title = `集成合并：${sources.rows.map((row) => String(row.identifier)).join('、')}`;
    await client.query(
      `INSERT INTO ${options.tasksTable}
         (id, board_id, identifier, kind, title, description, status, priority, labels,
          sort_order, creator_user_id, creator_name, version)
       VALUES ($1,$2,$3,'integration',$4,$5,'todo','high',ARRAY['integration']::text[],$6,$7,$8,1)`,
      [
        integrationTaskId,
        boardId,
        `TASK-${Number(nextNumber.rows[0]!.task_number)}`,
        title,
        '集成多个已复核交付任务；来源集合在启动时冻结。',
        Number(tail.rows[0]?.max_sort_order ?? 0) + SORT_GAP,
        identity.ownerUserId,
        identity.displayName?.trim() || identity.username,
      ],
    );
    for (const [index, row] of sources.rows.entries()) {
      await client.query(
        `INSERT INTO ${options.integrationSourcesTable}
           (id, integration_task_id, delivery_task_id, repository_id, provider_pull_request_id,
            reviewed_subject_digest, source_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(), integrationTaskId, row.id, repository.repositoryId,
          row.provider_pull_request_id, row.reviewed_subject_digest, index,
        ],
      );
      await appendChange(options, client, String(row.id), 'integration.source_added', 'system', identity.ownerUserId, {
        integrationTaskId,
        order: index,
      });
    }
    await client.query(
      `INSERT INTO ${options.mergeAuthorizationsTable}
         (id, source, actor_user_id, repository_id, integration_task_id, policy_revision)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), source, source === 'manual_batch' ? identity.ownerUserId : null,
        repository.repositoryId, integrationTaskId, policy.revision],
    );
    await client.query(
      `UPDATE ${options.integrationLanesTable}
          SET active_integration_task_id=$2, epoch=epoch+1, updated_at=now()
        WHERE repository_id=$1`,
      [repository.repositoryId, integrationTaskId],
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
    if (loaded.task.version !== input.expectedVersion) throw new TaskboardConflictError(loaded.task);
    if (['done', 'canceled'].includes(loaded.task.status)) {
      throw new TaskboardValidationError('Integration task is already terminal');
    }
    const active = await client.query(
      `SELECT 1 FROM ${options.executionsTable}
        WHERE task_id=$1 AND status IN ('queued','running','waiting_user','waiting_approval') LIMIT 1`,
      [taskId],
    );
    if (active.rows[0]) {
      throw new TaskboardValidationError('Stop the active merge execution before canceling');
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
      `SELECT s.*,d.identifier AS delivery_task_identifier,d.title AS delivery_task_title,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'id',a.id,'round',a.round,'remediationTaskId',a.remediation_task_id,
                'remediationTaskIdentifier',r.identifier,'remediationTaskTitle',r.title,
                'state',a.state,'resolvedAt',a.resolved_at
              ) ORDER BY a.round),'[]'::jsonb)
                 FROM ${options.remediationAttemptsTable} a
                 JOIN ${options.tasksTable} r ON r.id=a.remediation_task_id
                WHERE a.integration_source_id=s.id) AS remediation_attempts
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
    const contract = resolveWorkflowContract(loaded.task, latestExecution?.purpose);
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
      ? await client.query(`SELECT * FROM ${options.commentsTable} WHERE task_id=$1 ORDER BY created_at,id`, [taskId])
      : undefined;
    const executions = include.has('executions')
      ? await client.query(
        `SELECT e.*,r.outcome AS resolution_outcome,r.summary AS resolution_summary,
                r.to_status AS task_status_after,r.ignored_reason,r.historical AS resolution_historical,
                (r.execution_id IS NOT NULL) AS has_resolution,
                legacy.candidate_count AS legacy_resolution_count,
                legacy.valid_count AS legacy_resolution_valid_count
           FROM ${options.executionsTable} e
           LEFT JOIN ${options.resolutionsTable} r ON r.execution_id=e.id
           LEFT JOIN LATERAL (
             SELECT count(*)::int AS candidate_count,
                    count(*) FILTER (WHERE NULLIF(c.payload->>'outcome','') IS NOT NULL
                      AND NULLIF(c.payload->>'summary','') IS NOT NULL)::int AS valid_count
               FROM ${options.changesTable} c
              WHERE c.task_id=e.task_id AND c.change_type IN ('execution.resolved','execution.resolved.v2')
                AND (c.payload->>'executionId'=e.id
                  OR ((c.payload->>'executionId') IS NULL AND c.payload->>'runId'=e.run_id))
           ) legacy ON true
          WHERE e.task_id=$1 ORDER BY e.created_at,e.id`,
        [taskId],
      )
      : undefined;
    const sources = include.has('integrationSources') && loaded.task.kind === 'integration'
      ? await client.query(
        `SELECT * FROM ${options.integrationSourcesTable} WHERE integration_task_id=$1 ORDER BY source_order`,
        [taskId],
      )
      : undefined;
    const policy = jsonObject(loaded.board.integration_policy) as { revision?: string } | undefined;
    return {
      board: rowToBoard(loaded.board, identity.ownerUserId),
      task: loaded.task,
      ...(comments ? { comments: comments.rows.map(rowToComment) } : {}),
      ...(executions ? { executions: executions.rows.map(rowToExecution) } : {}),
      ...(sources ? { integrationSources: sources.rows.map(rowToIntegrationSource) } : {}),
      ...(page.length ? { changes: page.map(rowToChange) } : {}),
      asOfSeq,
      ...(page.length && changeRows.rows.length > limit
        ? { nextCursor: String(page[page.length - 1]!.seq) }
        : {}),
      hasMore: changeRows.rows.length > limit,
      contract,
      receipt: {
        ...(latestExecution ? {
          schemaVersion: 2 as const,
          runId: latestExecution.runId,
          executionId: latestExecution.id,
          attemptId: latestExecution.attemptId ?? latestExecution.id,
          purpose: latestExecution.purpose,
          workflowEpoch: String(latestExecutionResult.rows[0]?.workflow_epoch ?? '0'),
          fenceEpoch: latestExecution.fenceEpoch ?? '0',
        } : {}),
        taskId,
        taskVersion: loaded.task.version,
        changeSeq: asOfSeq,
        contractDigest: contract.digest,
        policyRevision: policy?.revision ?? 'none',
        ...(loaded.task.reviewedSubjectDigest
          ? { subjectDigest: loaded.task.reviewedSubjectDigest }
          : {}),
      },
    };
  } finally {
    client.release();
  }
}

export async function createExecutionCommentV2(
  options: TaskboardV2StoreOptions,
  identity: TaskboardIdentity,
  runId: string,
  body: string,
) {
  const normalized = body.trim();
  if (!normalized) throw new TaskboardValidationError('Comment body is required');
  return withTransaction(options, async (client) => {
    const execution = await client.query(
      `SELECT e.task_id
         FROM ${options.executionsTable} e
         JOIN ${options.tasksTable} t ON t.id=e.task_id
         JOIN ${options.boardsTable} b ON b.id=t.board_id
        WHERE e.run_id=$1 AND e.status IN ('queued','running','waiting_user','waiting_approval')
          AND e.resolved_at IS NULL AND e.superseded_at IS NULL
          AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')
        FOR UPDATE OF e`,
      [runId, identity.tenantId, identity.ownerUserId],
    );
    if (!execution.rows[0]) throw new TaskboardNotFoundError('Active taskboard execution not found');
    const taskId = String(execution.rows[0].task_id);
    const result = await client.query(
      `INSERT INTO ${options.commentsTable}
         (id, task_id, body, author_type, author_id, author_name, continuation_eligible, version)
       VALUES ($1,$2,$3,'agent',$4,'Agent',false,1)
       RETURNING *`,
      [randomUUID(), taskId, normalized, runId],
    );
    await appendChange(options, client, taskId, 'execution.comment', 'agent', runId, {
      commentId: String(result.rows[0]!.id),
    });
    return rowToComment(result.rows[0]!);
  });
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

export async function enqueueOnReadyTrigger(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  board: Record<string, unknown>,
  taskId: string,
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
     VALUES ($1,$2,$3,'on_ready',$4,now()+($5::bigint * interval '1 millisecond'))
     ON CONFLICT DO NOTHING`,
    [randomUUID(), board.id, taskId, policy.revision, Math.max(0, Number(policy.trigger.debounceMs ?? 0))],
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
            (SELECT count(*)::int FROM ${options.commentsTable} c WHERE c.task_id=t.id) AS comment_count,
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
            (SELECT count(*)::int FROM ${options.commentsTable} c WHERE c.task_id=t.id) AS comment_count,
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
