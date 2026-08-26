import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type {
  TaskBoardTask,
  TaskBoardTaskCreateInput,
} from '../../../shared/src/types/taskboard.js';
import {
  assertTaskContent,
  normalizeAttachments,
  normalizeLabels,
  optionalText,
  rowToTask,
  visibleCommentPredicate,
} from './storeHelpers.js';
import { claimExistingTaskCreation, completeTaskCreationClaim, newTaskCreationClaim, taskCreationRequestDigest, waitForTaskCreationClaim } from './taskCreationLifecycle.js';
import {
  TaskboardNotFoundError,
  TaskboardValidationError,
  type TaskboardIdentity,
  type TaskboardTaskCreateResult,
} from './types.js';

interface ExecutionTaskActionOptions {
  pool: { connect(): Promise<PoolClient> };
  boardsTable: string;
  tasksTable: string;
  commentsTable: string;
  executionsTable: string;
  changesTable: string;
}

const ACTIVE_EXECUTION_STATUSES = ['queued', 'running', 'waiting_user', 'waiting_approval'];
const SORT_GAP = 1024;

export async function updateTaskBranchFromExecution(
  options: ExecutionTaskActionOptions,
  identity: TaskboardIdentity,
  runId: string,
  branch: string | null,
): Promise<TaskBoardTask> {
  return withActiveExecutionTask(options, identity, runId, async (client, task) => {
    if (task.kind === 'advisory') {
      throw new TaskboardValidationError(
        'Advisory tasks cannot carry a repository branch',
        'TASKBOARD_ADVISORY_REPOSITORY_FORBIDDEN',
      );
    }
    await client.query(
      `UPDATE ${options.tasksTable}
          SET branch=$2, version=version+1, updated_at=now()
        WHERE id=$1`,
      [task.id, optionalText(branch)],
    );
    await client.query(
      `INSERT INTO ${options.changesTable}
         (task_id, change_type, actor_type, actor_id, payload)
       VALUES ($1,'task.branch_updated','agent',$2,$3::jsonb)`,
      [task.id, runId, JSON.stringify({ branch: optionalText(branch) })],
    );
    return loadTask(options, client, task.id);
  });
}

export async function createTaskFromExecution(
  options: ExecutionTaskActionOptions,
  identity: TaskboardIdentity,
  runId: string,
  input: TaskBoardTaskCreateInput,
): Promise<TaskBoardTask> {
  const initial = await createTaskFromExecutionWithResult(options, identity, runId, input);
  const result = await waitForTaskCreationClaim(initial, () => createTaskFromExecutionWithResult(options, identity, runId, input));
  if (result.creationClaimToken) {
    const client = await options.pool.connect();
    try { await completeTaskCreationClaim(client, options.tasksTable, result.task.id, result.creationClaimToken); }
    finally { client.release(); }
  }
  return result.task;
}

export async function createTaskFromExecutionWithResult(
  options: ExecutionTaskActionOptions,
  identity: TaskboardIdentity,
  runId: string,
  input: TaskBoardTaskCreateInput,
  requestDigest?: string,
): Promise<TaskboardTaskCreateResult> {
  assertTaskContent(input.title, input.description);
  return withActiveExecutionTask(options, identity, runId, async (client, currentTask) => {
    if (currentTask.kind === 'advisory') {
      throw new TaskboardValidationError(
        'Advisory executions cannot create workflow follow-up tasks',
        'TASKBOARD_ADVISORY_CAPABILITY_FORBIDDEN',
      );
    }
    if (input.status !== undefined && input.status !== 'todo') {
      throw new TaskboardValidationError('Taskboard Execution may only create todo follow-up tasks');
    }
    const kind = input.kind ?? 'delivery';
    if (currentTask.kind === 'integration' && kind === 'remediation') {
      throw new TaskboardValidationError('Integration Agent cannot create legacy remediation tasks');
    }
    const creationDigest = requestDigest ?? taskCreationRequestDigest({
      boardId: currentTask.boardId, ...input, kind,
    });
    if (kind === 'integration') {
      throw new TaskboardValidationError('Integration tasks require an integration batch');
    }
    if (input.clientRequestId) {
      const existing = await claimExistingTaskCreation(
        client, options, currentTask.boardId, input.clientRequestId, creationDigest,
      );
      if (existing) return existing;
    }
    const numberResult = await client.query(
      `UPDATE ${options.boardsTable}
          SET next_task_number=next_task_number+1
        WHERE id=$1 AND tenant_id=$2
          AND (owner_user_id=$3 OR visibility='organization')
        RETURNING next_task_number-1 AS task_number`,
      [currentTask.boardId, identity.tenantId, identity.ownerUserId],
    );
    if (!numberResult.rows[0]) throw new TaskboardNotFoundError('Board not found');
    const tail = await client.query(
      `SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order
         FROM ${options.tasksTable}
        WHERE board_id=$1 AND status='todo' AND archived_at IS NULL`,
      [currentTask.boardId],
    );
    const taskId = randomUUID();
    const creation = newTaskCreationClaim(input.clientRequestId);
    await client.query(
      `INSERT INTO ${options.tasksTable}
         (id, board_id, identifier, title, description, kind, branch, attachments, status, priority, labels,
          sort_order, due_at, model, creator_user_id, creator_name, completed_at, client_request_id,
          creation_request_digest,creation_state,creation_lease_id,creation_lease_expires_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'todo',$9,$10,$11,$12,$13,$14,$15,NULL,$16,$17,$18,$19,
               CASE WHEN $18='pending' THEN now()+interval '5 minutes' END,1)`,
      [
        taskId,
        currentTask.boardId,
        `TASK-${Number(numberResult.rows[0].task_number)}`,
        input.title ?? '',
        input.description ?? '',
        kind,
        optionalText(input.branch),
        JSON.stringify(normalizeAttachments(input.attachments)),
        input.priority ?? 'none',
        normalizeLabels(input.labels),
        Number(tail.rows[0]?.max_sort_order ?? 0) + SORT_GAP,
        input.dueAt ?? null,
        optionalText(input.model),
        identity.ownerUserId,
        identity.displayName?.trim() || identity.username,
        optionalText(input.clientRequestId),
        input.clientRequestId ? creationDigest : null,
        creation.state,
        creation.token,
      ],
    );
    await client.query(
      `INSERT INTO ${options.changesTable}
         (task_id, change_type, actor_type, actor_id, payload)
       VALUES ($1,'task.created_from_execution','agent',$2,$3::jsonb)`,
      [taskId, runId, JSON.stringify({ sourceTaskId: currentTask.id, kind })],
    );
    return {
      task: await loadTask(options, client, taskId),
      created: true,
      ...(creation.token ? { creationClaimToken: creation.token } : {}),
    };
  });
}

async function withActiveExecutionTask<T>(
  options: ExecutionTaskActionOptions,
  identity: TaskboardIdentity,
  runId: string,
  operation: (client: PoolClient, task: TaskBoardTask) => Promise<T>,
): Promise<T> {
  const client = await options.pool.connect();
  try {
    await client.query('BEGIN');
    const boardResult = await client.query(
      `SELECT b.id, b.archived_at
         FROM ${options.executionsTable} e
         JOIN ${options.tasksTable} t ON t.id=e.task_id
         JOIN ${options.boardsTable} b ON b.id=t.board_id
        WHERE e.run_id=$1 AND b.tenant_id=$2
          AND (b.owner_user_id=$3 OR b.visibility='organization')
        FOR UPDATE OF b`,
      [runId, identity.tenantId, identity.ownerUserId],
    );
    const board = boardResult.rows[0];
    if (!board) throw new TaskboardNotFoundError('Taskboard execution not found');
    const taskResult = await client.query(
      `SELECT t.*,
              (SELECT count(*)::int FROM ${options.commentsTable} c WHERE c.task_id=t.id AND ${visibleCommentPredicate('c', options.changesTable)}) AS comment_count
         FROM ${options.executionsTable} e
         JOIN ${options.tasksTable} t ON t.id=e.task_id
        WHERE e.run_id=$1 AND t.board_id=$2
        FOR UPDATE OF t`,
      [runId, board.id],
    );
    if (!taskResult.rows[0]) throw new TaskboardNotFoundError('Taskboard execution not found');
    const task = rowToTask(taskResult.rows[0]);
    if (board.archived_at || task.archivedAt) {
      throw new TaskboardValidationError('Archived taskboard resources are read-only');
    }
    const executionResult = await client.query(
      `SELECT status,transitioned_at,superseded_at FROM ${options.executionsTable} WHERE run_id=$1 FOR UPDATE`,
      [runId],
    );
    if (!executionResult.rows[0]
      || executionResult.rows[0].transitioned_at || executionResult.rows[0].superseded_at
      || !ACTIVE_EXECUTION_STATUSES.includes(String(executionResult.rows[0].status))) {
      throw new TaskboardValidationError(
        'Taskboard execution is no longer active',
        'TASKBOARD_EXECUTION_INACTIVE',
      );
    }
    const result = await operation(client, task);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function loadTask(
  options: ExecutionTaskActionOptions,
  client: PoolClient,
  taskId: string,
): Promise<TaskBoardTask> {
  const result = await client.query(
    `SELECT t.*,
            (SELECT count(*)::int FROM ${options.commentsTable} c WHERE c.task_id=t.id AND ${visibleCommentPredicate('c', options.changesTable)}) AS comment_count
       FROM ${options.tasksTable} t
      WHERE t.id=$1`,
    [taskId],
  );
  if (!result.rows[0]) throw new TaskboardNotFoundError('Task not found');
  return rowToTask(result.rows[0]);
}
