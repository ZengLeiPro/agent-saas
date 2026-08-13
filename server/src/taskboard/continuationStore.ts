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

class PartialContinuationClaimError extends Error {}

export interface TaskboardContinuationStoreHost {
  pool: Pool;
  boardsTable: string;
  tasksTable: string;
  commentsTable: string;
  executionsTable: string;
}

export async function loadExecutionContext(
  host: TaskboardContinuationStoreHost,
  runId: string,
): Promise<TaskboardExecutionContext | null> {
  const result = await host.pool.query(
    `SELECT e.*, b.tenant_id, b.owner_user_id, b.prompt AS board_prompt,
            previous.created_at AS previous_created_at
       FROM ${host.executionsTable} e
       JOIN ${host.tasksTable} t ON t.id=e.task_id
       JOIN ${host.boardsTable} b ON b.id=t.board_id
       LEFT JOIN LATERAL (
         SELECT prior.created_at
           FROM ${host.executionsTable} prior
          WHERE prior.task_id=e.task_id
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
  const continuation = Boolean(row.previous_created_at);
  const commentsResult = await host.pool.query(
    `SELECT c.*
       FROM ${host.commentsTable} c
      WHERE c.task_id=$1
        AND ($2::boolean=false OR (c.author_type='user' AND c.continuation_run_id=$3))
      ORDER BY c.created_at, c.id`,
    [execution.taskId, continuation, runId],
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
      WHERE c.id=$1 AND c.task_id=$2 AND c.author_type='user'
        AND b.tenant_id=$3 AND (b.owner_user_id=$4 OR b.visibility='organization')`,
    [commentId, taskId, identity.tenantId, identity.ownerUserId],
  );
  if (!commentResult.rows[0]) throw new TaskboardNotFoundError('Comment not found');
  const executions = await listTaskExecutions(host, identity, taskId);
  const activeExecution = executions.find((execution) => !isTerminalExecutionStatus(execution.status));
  const continuationRunId = commentResult.rows[0].continuation_run_id
    ? String(commentResult.rows[0].continuation_run_id)
    : undefined;
  const pendingResult = await host.pool.query(
    `SELECT c.* FROM ${host.commentsTable} c
      WHERE c.task_id=$1 AND c.author_type='user'
        AND c.created_at <= $2::timestamptz
        AND (c.continuation_run_id IS NULL OR c.continuation_run_id=$3)
      ORDER BY c.created_at, c.id`,
    [taskId, commentResult.rows[0].created_at, continuationRunId ?? null],
  );
  return {
    task,
    comment: applyCommentAuthorDisplayName(rowToComment(commentResult.rows[0]), identity),
    pendingComments: pendingResult.rows.map((row) => applyCommentAuthorDisplayName(rowToComment(row), identity)),
    ...(continuationRunId ? { continuationRunId } : {}),
    ...(executions[0] ? { latestExecution: executions[0] } : {}),
    ...(activeExecution ? { activeExecution } : {}),
  };
}

export async function markContinuationQueued(
  host: TaskboardContinuationStoreHost,
  taskId: string,
  commentIds: string[],
  runId: string,
): Promise<boolean> {
  if (commentIds.length === 0) return false;
  try {
    return await withTransaction(host.pool, async (client) => {
      const result = await client.query(
        `UPDATE ${host.commentsTable}
            SET continuation_run_id=$3, updated_at=now()
          WHERE task_id=$1 AND id=ANY($2::text[])
            AND (continuation_run_id IS NULL OR continuation_run_id=$3)
          RETURNING id`,
        [taskId, commentIds, runId],
      );
      if (result.rowCount !== commentIds.length) throw new PartialContinuationClaimError();
      return true;
    });
  } catch (error) {
    if (error instanceof PartialContinuationClaimError) return false;
    throw error;
  }
}

export function markContinuationRunning(
  host: TaskboardContinuationStoreHost,
  taskId: string,
): Promise<TaskBoardTask | null> {
  return withTransaction(host.pool, async (client) => {
    const loaded = await loadInternalTaskForUpdate(host, client, taskId);
    if (!loaded) return null;
    assertWritableTask(loaded.task, loaded.boardArchivedAt);
    if (loaded.task.status === 'in_progress') return loaded.task;
    const sortOrder = await nextTaskColumnSortOrder(
      host,
      client,
      loaded.identity,
      loaded.task.boardId,
      taskId,
      'in_progress',
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

export function completeContinuation(
  host: TaskboardContinuationStoreHost,
  taskId: string,
  runId: string,
  input: TaskboardExecutionCompletionInput,
): Promise<TaskBoardTask | null> {
  return withTransaction(host.pool, async (client) => {
    const loaded = await loadInternalTaskForUpdate(host, client, taskId);
    if (!loaded) return null;
    const existing = await client.query(
      `SELECT id FROM ${host.commentsTable}
        WHERE task_id=$1 AND author_id=$2 AND author_type IN ('agent', 'system')
        LIMIT 1`,
      [taskId, runId],
    );
    if (existing.rows[0]) return loaded.task;
    const claimed = await client.query(
      `SELECT id FROM ${host.commentsTable}
        WHERE task_id=$1 AND continuation_run_id=$2 AND author_type='user'
        LIMIT 1`,
      [taskId, runId],
    );
    if (!claimed.rows[0] || loaded.task.status !== 'in_progress') return loaded.task;
    const activeExecution = await client.query(
      `SELECT id FROM ${host.executionsTable}
        WHERE task_id=$1 AND status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
        LIMIT 1`,
      [taskId],
    );
    if (activeExecution.rows[0]) return loaded.task;

    const targetStatus = input.status === 'succeeded' ? 'in_review' : 'blocked';
    if (loaded.task.status === 'in_progress') {
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
    return loadAccessibleTask(host, loaded.identity, taskId, client);
  });
}

export async function loadExecutionModelContext(
  host: TaskboardContinuationStoreHost,
  identity: TaskboardIdentity,
  taskId: string,
): Promise<TaskboardExecutionModelContext> {
  const result = await host.pool.query(
    `SELECT t.model AS task_model, b.model AS board_model, b.owner_user_id AS board_owner_user_id
       FROM ${host.tasksTable} t
       JOIN ${host.boardsTable} b ON b.id=t.board_id
      WHERE t.id=$1 AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')`,
    [taskId, identity.tenantId, identity.ownerUserId],
  );
  if (!result.rows[0]) throw new TaskboardNotFoundError('Task not found');
  return rowToExecutionModelContext(result.rows[0]);
}

export async function listTaskExecutions(
  host: TaskboardContinuationStoreHost,
  identity: TaskboardIdentity,
  taskId: string,
): Promise<TaskBoardExecution[]> {
  const result = await host.pool.query(
    `SELECT e.*
       FROM ${host.executionsTable} e
       JOIN ${host.tasksTable} t ON t.id=e.task_id
       JOIN ${host.boardsTable} b ON b.id=t.board_id
      WHERE e.task_id=$1 AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 50`,
    [taskId, identity.tenantId, identity.ownerUserId],
  );
  return result.rows.map(rowToExecution);
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
