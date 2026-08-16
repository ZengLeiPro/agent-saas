import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import type {
  TaskBoardExecution,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import {
  applyCommentAuthorDisplayName,
  assertWritableTask,
  isTerminalExecutionStatus,
  normalizeAttachments,
  requireText,
  rowToComment,
  rowToExecution,
  rowToExecutionModelContext,
  rowToTask,
} from './storeHelpers.js';
import {
  TaskboardNotFoundError,
  type TaskboardContinuationContext,
  type TaskboardExecutionCompletionInput,
  type TaskboardExecutionContext,
  type TaskboardExecutionModelContext,
  type TaskboardIdentity,
} from './types.js';

const DEFAULT_SORT_GAP = 1024;

export interface TaskboardContinuationStoreHost {
  pool: Pool;
  boardsTable: string;
  tasksTable: string;
  commentsTable: string;
  executionsTable: string;
  continuationOutboxTable: string;
}

export async function loadExecutionContext(
  host: TaskboardContinuationStoreHost,
  runId: string,
): Promise<TaskboardExecutionContext | null> {
  const result = await host.pool.query(
    `SELECT e.*, b.tenant_id, b.owner_user_id, b.prompt AS board_prompt,
            previous.context_since
       FROM ${host.executionsTable} e
       JOIN ${host.tasksTable} t ON t.id=e.task_id
       JOIN ${host.boardsTable} b ON b.id=t.board_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(prior.finished_at, prior.updated_at, prior.created_at) AS context_since
           FROM ${host.executionsTable} prior
          WHERE prior.task_id=e.task_id AND prior.session_id=e.session_id
            AND (prior.created_at < e.created_at OR (prior.created_at=e.created_at AND prior.id < e.id))
          ORDER BY prior.created_at DESC, prior.id DESC
          LIMIT 1
       ) previous ON true
      WHERE e.run_id=$1`,
    [runId],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  const identity: TaskboardIdentity = {
    tenantId: String(row.tenant_id),
    ownerUserId: String(row.owner_user_id),
    username: '',
  };
  const execution = rowToExecution(row);
  const contextSince = row.context_since ?? null;
  const continuation = Boolean(contextSince);
  const commentsResult = await host.pool.query(
    `SELECT c.*
       FROM ${host.commentsTable} c
      WHERE c.task_id=$1
        AND ($2::timestamptz IS NULL OR c.created_at >= $2::timestamptz)
      ORDER BY c.created_at, c.id`,
    [execution.taskId, contextSince],
  );
  return {
    identity,
    task: await loadAccessibleTask(host, identity, execution.taskId),
    boardPrompt: String(row.board_prompt ?? ''),
    comments: commentsResult.rows.map((commentRow) => applyCommentAuthorDisplayName(
      rowToComment(commentRow),
      identity,
    )),
    execution,
    continuation,
  };
}

export async function loadContinuationContext(
  host: TaskboardContinuationStoreHost,
  identity: TaskboardIdentity,
  taskId: string,
  commentId: string,
): Promise<TaskboardContinuationContext> {
  const task = await loadAccessibleTask(host, identity, taskId);
  const commentResult = await host.pool.query(
    `SELECT c.*
       FROM ${host.commentsTable} c
       JOIN ${host.tasksTable} t ON t.id=c.task_id
       JOIN ${host.boardsTable} b ON b.id=t.board_id
      WHERE c.id=$1 AND c.task_id=$2 AND c.author_type='user' AND c.continuation_eligible=true
        AND t.archived_at IS NULL AND b.archived_at IS NULL
        AND b.tenant_id=$3 AND (b.owner_user_id=$4 OR b.visibility='organization')`,
    [commentId, taskId, identity.tenantId, identity.ownerUserId],
  );
  if (!commentResult.rows[0]) throw new TaskboardNotFoundError('Comment not found');
  const executions = await listTaskExecutions(host, identity, taskId);
  const activeExecution = executions.find((execution) => !isTerminalExecutionStatus(execution.status));
  const continuationRunId = commentResult.rows[0].continuation_run_id
    ? String(commentResult.rows[0].continuation_run_id)
    : undefined;
  const [pendingResult, activeContinuationResult, continuationExecution] = await Promise.all([
    host.pool.query(
      `SELECT c.* FROM ${host.commentsTable} c
        WHERE c.task_id=$1 AND c.author_type='user' AND c.continuation_eligible=true
          AND c.created_at <= $2::timestamptz
          AND (c.continuation_run_id IS NULL OR c.continuation_run_id=$3)
        ORDER BY c.created_at, c.id`,
      [taskId, commentResult.rows[0].created_at, continuationRunId ?? null],
    ),
    host.pool.query(
      `SELECT 1 FROM ${host.continuationOutboxTable}
        WHERE task_id=$1 AND status<>'completed' LIMIT 1`,
      [taskId],
    ),
    continuationRunId
      ? loadTaskExecutionByRunId(host, identity, taskId, continuationRunId)
      : Promise.resolve(null),
  ]);
  return {
    task,
    comment: applyCommentAuthorDisplayName(rowToComment(commentResult.rows[0]), identity),
    pendingComments: pendingResult.rows.map((row) => applyCommentAuthorDisplayName(rowToComment(row), identity)),
    ...(continuationRunId ? { continuationRunId } : {}),
    ...(activeContinuationResult.rows[0] ? { hasActiveContinuation: true } : {}),
    ...(executions[0] ? { latestExecution: executions[0] } : {}),
    ...(activeExecution ? { activeExecution } : {}),
    ...(continuationExecution ? { continuationExecution } : {}),
  };
}

export function markContinuationRunning(
  host: TaskboardContinuationStoreHost,
  taskId: string,
  runId: string,
  reconcileLeaseId?: string,
): Promise<TaskBoardTask | null> {
  return withTransaction(host.pool, async (client) => {
    const loaded = await loadInternalTaskForUpdate(host, client, taskId);
    if (!loaded) return null;
    const outbox = await client.query(
      `SELECT status, ($3::text IS NULL OR (
          reconcile_lease_id=$3 AND reconcile_lease_expires_at > clock_timestamp()
        )) AS reconcile_lease_valid
         FROM ${host.continuationOutboxTable}
        WHERE run_id=$1 AND task_id=$2 FOR UPDATE`,
      [runId, taskId, reconcileLeaseId ?? null],
    );
    if (!outbox.rows[0] || outbox.rows[0].status === 'completed'
      || outbox.rows[0].reconcile_lease_valid !== true) return loaded.task;
    assertWritableTask(loaded.task, loaded.boardArchivedAt);
    if (loaded.task.status === 'in_progress') return loaded.task;
    const sortOrder = await nextTaskColumnSortOrder(
      host, client, loaded.identity, loaded.task.boardId, taskId, 'in_progress',
    );
    await client.query(
      `UPDATE ${host.tasksTable}
          SET status='in_progress', sort_order=$2, completed_at=NULL,
              version=version+1, updated_at=now()
        WHERE id=$1`,
      [taskId, sortOrder],
    );
    return loadAccessibleTask(host, loaded.identity, taskId, client);
  });
}

export async function hasSuccessfulContinuationSince(
  host: TaskboardContinuationStoreHost,
  client: PoolClient,
  taskId: string,
  since: string | Date,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM ${host.continuationOutboxTable} o
       JOIN ${host.commentsTable} source
         ON source.id=o.comment_id AND source.task_id=o.task_id
      WHERE o.task_id=$1 AND o.status='completed'
        AND source.author_type='user' AND source.continuation_run_id=o.run_id
        AND source.created_at >= $2::timestamptz
        AND EXISTS (
          SELECT 1 FROM ${host.commentsTable} receipt
           WHERE receipt.task_id=o.task_id AND receipt.author_id=o.run_id
             AND receipt.author_type='agent'
        )
      LIMIT 1`,
    [taskId, since],
  );
  return Boolean(result.rows[0]);
}

export function completeContinuation(
  host: TaskboardContinuationStoreHost,
  taskId: string,
  runId: string,
  input: TaskboardExecutionCompletionInput,
): Promise<TaskBoardTask | null> {
  return withTransaction(host.pool, async (client) => {
    const loaded = await loadInternalTaskForUpdate(host, client, taskId);
    if (!loaded) return null;
    if (loaded.task.archivedAt || loaded.boardArchivedAt) {
      await markContinuationCompleted(host, client, runId);
      return loaded.task;
    }
    const formalExecution = await client.query(
      `SELECT id FROM ${host.executionsTable} WHERE task_id=$1 AND run_id=$2 LIMIT 1`,
      [taskId, runId],
    );
    if (formalExecution.rows[0]) {
      await markContinuationCompleted(host, client, runId);
      return loaded.task;
    }
    const existing = await client.query(
      `SELECT id FROM ${host.commentsTable}
        WHERE task_id=$1 AND author_id=$2 AND author_type IN ('agent', 'system')
        LIMIT 1`,
      [taskId, runId],
    );
    if (existing.rows[0]) {
      await markContinuationCompleted(host, client, runId);
      return loaded.task;
    }
    const claimed = await client.query(
      `SELECT id FROM ${host.commentsTable}
        WHERE task_id=$1 AND continuation_run_id=$2 AND author_type='user'
        LIMIT 1`,
      [taskId, runId],
    );
    if (!claimed.rows[0]) return loaded.task;
    const activeExecution = await client.query(
      `SELECT id FROM ${host.executionsTable}
        WHERE task_id=$1 AND status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
        LIMIT 1`,
      [taskId],
    );

    const targetStatus = input.status === 'succeeded' ? 'in_review' : 'blocked';
    const blockedByExecution = input.status === 'succeeded' && loaded.task.status === 'blocked'
      ? Boolean((await client.query(
        `SELECT 1
           FROM ${host.executionsTable} e
           JOIN ${host.tasksTable} t ON t.id=e.task_id
          WHERE e.task_id=$1 AND e.status IN ('failed', 'cancelled')
            AND e.finished_at=t.updated_at
          LIMIT 1`,
        [taskId],
      )).rows[0])
      : false;
    const shouldMoveTask = loaded.task.status === 'in_progress' || blockedByExecution;
    if (shouldMoveTask && !activeExecution.rows[0]) {
      const sortOrder = await nextTaskColumnSortOrder(
        host,
        client,
        loaded.identity,
        loaded.task.boardId,
        taskId,
        targetStatus,
      );
      await client.query(
        `UPDATE ${host.tasksTable}
            SET status=$2, sort_order=$3, completed_at=NULL,
                version=version+1, updated_at=now()
          WHERE id=$1`,
        [taskId, targetStatus, sortOrder],
      );
    }
    await client.query(
      `INSERT INTO ${host.commentsTable}
         (id, task_id, body, attachments, author_type, author_id, author_name, version)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,1)`,
      [randomUUID(), taskId, requireText(input.commentBody, 'Continuation comment body'),
        JSON.stringify(normalizeAttachments(input.attachments)),
        input.status === 'succeeded' ? 'agent' : 'system', runId,
        input.status === 'succeeded' ? 'Agent' : '系统'],
    );
    await markContinuationCompleted(host, client, runId);
    return loadAccessibleTask(host, loaded.identity, taskId, client);
  });
}

export async function loadExecutionModelContext(
  host: TaskboardContinuationStoreHost,
  identity: TaskboardIdentity,
  taskId: string,
): Promise<TaskboardExecutionModelContext> {
  const result = await host.pool.query(
    `SELECT t.model AS task_model, t.kind AS task_kind, t.status AS task_status,
            b.model AS board_model, b.owner_user_id AS board_owner_user_id,
            b.integration_policy->>'revision' AS policy_revision,
            b.id AS board_id, b.name AS board_name
       FROM ${host.tasksTable} t
       JOIN ${host.boardsTable} b ON b.id=t.board_id
      WHERE t.id=$1 AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')`,
    [taskId, identity.tenantId, identity.ownerUserId],
  );
  if (!result.rows[0]) throw new TaskboardNotFoundError('Task not found');
  return rowToExecutionModelContext(result.rows[0]);
}

async function loadTaskExecutionByRunId(
  host: TaskboardContinuationStoreHost,
  identity: TaskboardIdentity,
  taskId: string,
  runId: string,
): Promise<TaskBoardExecution | null> {
  const result = await host.pool.query(
    `SELECT e.*
       FROM ${host.executionsTable} e
       JOIN ${host.tasksTable} t ON t.id=e.task_id
       JOIN ${host.boardsTable} b ON b.id=t.board_id
      WHERE e.task_id=$1 AND e.run_id=$2
        AND b.tenant_id=$3 AND (b.owner_user_id=$4 OR b.visibility='organization')
      LIMIT 1`,
    [taskId, runId, identity.tenantId, identity.ownerUserId],
  );
  return result.rows[0] ? rowToExecution(result.rows[0]) : null;
}

export async function listTaskExecutions(
  host: TaskboardContinuationStoreHost,
  identity: TaskboardIdentity,
  taskId: string,
): Promise<TaskBoardExecution[]> {
  const result = await host.pool.query(
    `SELECT e.*,
            EXISTS (
              SELECT 1 FROM ${host.continuationOutboxTable} continuation
               WHERE continuation.task_id=e.task_id AND continuation.status<>'completed'
            ) AS continuation_active
       FROM ${host.executionsTable} e
       JOIN ${host.tasksTable} t ON t.id=e.task_id
       JOIN ${host.boardsTable} b ON b.id=t.board_id
      WHERE e.task_id=$1 AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 50`,
    [taskId, identity.tenantId, identity.ownerUserId],
  );
  return result.rows.map((row, index) => ({
    ...rowToExecution(row),
    ...(index === 0 && row.continuation_active === true ? { continuationActive: true } : {}),
  }));
}

async function loadAccessibleTask(
  host: TaskboardContinuationStoreHost,
  identity: TaskboardIdentity,
  taskId: string,
  db: Pool | PoolClient = host.pool,
): Promise<TaskBoardTask> {
  const result = await db.query(
    `SELECT t.*,
            (SELECT count(*)::int FROM ${host.commentsTable} c WHERE c.task_id=t.id) AS comment_count
       FROM ${host.tasksTable} t
       JOIN ${host.boardsTable} b ON b.id=t.board_id
      WHERE t.id=$1 AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')`,
    [taskId, identity.tenantId, identity.ownerUserId],
  );
  if (!result.rows[0]) throw new TaskboardNotFoundError('Task not found');
  return rowToTask(result.rows[0]);
}

async function loadInternalTaskForUpdate(
  host: TaskboardContinuationStoreHost,
  client: PoolClient,
  taskId: string,
): Promise<{
  identity: TaskboardIdentity;
  task: TaskBoardTask;
  boardArchivedAt?: string;
} | null> {
  const ownership = await client.query(
    `SELECT t.board_id, b.tenant_id, b.owner_user_id
       FROM ${host.tasksTable} t
       JOIN ${host.boardsTable} b ON b.id=t.board_id
      WHERE t.id=$1`,
    [taskId],
  );
  if (!ownership.rows[0]) return null;
  const row = ownership.rows[0];
  await client.query(`SELECT id FROM ${host.boardsTable} WHERE id=$1 FOR UPDATE`, [row.board_id]);
  const result = await client.query(
    `SELECT t.*, b.archived_at AS board_archived_at,
            (SELECT count(*)::int FROM ${host.commentsTable} c WHERE c.task_id=t.id) AS comment_count
       FROM ${host.tasksTable} t
       JOIN ${host.boardsTable} b ON b.id=t.board_id
      WHERE t.id=$1
      FOR UPDATE OF t`,
    [taskId],
  );
  if (!result.rows[0]) return null;
  return {
    identity: {
      tenantId: String(row.tenant_id),
      ownerUserId: String(row.owner_user_id),
      username: '',
    },
    task: rowToTask(result.rows[0]),
    ...(result.rows[0].board_archived_at
      ? { boardArchivedAt: new Date(result.rows[0].board_archived_at).toISOString() }
      : {}),
  };
}

export async function nextTaskColumnSortOrder(
  host: TaskboardContinuationStoreHost,
  client: PoolClient,
  identity: TaskboardIdentity,
  boardId: string,
  taskId: string,
  status: TaskBoardTask['status'],
): Promise<number> {
  const peers = await client.query(
    `SELECT t.sort_order
       FROM ${host.tasksTable} t
       JOIN ${host.boardsTable} b ON b.id=t.board_id
      WHERE t.board_id=$1 AND t.id<>$2 AND t.status=$3 AND t.archived_at IS NULL
        AND b.tenant_id=$4 AND (b.owner_user_id=$5 OR b.visibility='organization')
      ORDER BY t.sort_order DESC, t.created_at DESC, t.id DESC
      FOR UPDATE OF t`,
    [boardId, taskId, status, identity.tenantId, identity.ownerUserId],
  );
  const lastSortOrder = peers.rows[0] ? Number(peers.rows[0].sort_order) : 0;
  return Number.isFinite(lastSortOrder) ? lastSortOrder + DEFAULT_SORT_GAP : DEFAULT_SORT_GAP;
}

function markContinuationCompleted(
  host: TaskboardContinuationStoreHost,
  client: PoolClient,
  runId: string,
): Promise<unknown> {
  return client.query(
    `UPDATE ${host.continuationOutboxTable}
        SET status='completed', lease_id=NULL, lease_expires_at=NULL,
            reconcile_lease_id=NULL, reconcile_lease_expires_at=NULL, updated_at=now()
      WHERE run_id=$1`,
    [runId],
  );
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
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
