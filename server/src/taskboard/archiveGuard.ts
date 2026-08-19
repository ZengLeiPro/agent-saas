import type { PoolClient } from 'pg';

import type { TaskBoardExecution, TaskBoardExecutionStartResult, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { optionalText, rowToExecution } from './storeHelpers.js';
import { TaskboardValidationError, type TaskboardExecutionCompletionInput } from './types.js';

export interface TaskboardArchiveGuardHost {
  tasksTable: string;
  executionsTable: string;
  continuationOutboxTable: string;
  executionOutboxTable: string;
}

export async function assertBoardHasNoActiveRuns(
  host: TaskboardArchiveGuardHost,
  client: PoolClient,
  boardId: string,
): Promise<void> {
  const active = await client.query(
    `SELECT 1
       FROM ${host.tasksTable} t
      WHERE t.board_id=$1 AND (
        EXISTS (
          SELECT 1 FROM ${host.executionsTable} e
           WHERE e.task_id=t.id
             AND e.status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
        ) OR EXISTS (
          SELECT 1 FROM ${host.continuationOutboxTable} o
           WHERE o.task_id=t.id AND o.status<>'completed'
        )
      ) LIMIT 1`,
    [boardId],
  );
  if (active.rows[0]) throw activeRunError();
}

export async function assertTaskHasNoActiveRuns(
  host: TaskboardArchiveGuardHost,
  client: PoolClient,
  taskId: string,
): Promise<void> {
  const active = await client.query(
    `SELECT 1 WHERE EXISTS (
       SELECT 1 FROM ${host.executionsTable}
        WHERE task_id=$1 AND status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
     ) OR EXISTS (
       SELECT 1 FROM ${host.continuationOutboxTable}
        WHERE task_id=$1 AND status<>'completed'
     )`,
    [taskId],
  );
  if (active.rows[0]) throw activeRunError();
}

/** 首次交给 Agent 后，任务标题/正文改走评论，避免执行上下文与任务对象脱节。 */
export async function assertTaskHasNoExecutionHistory(
  host: TaskboardArchiveGuardHost,
  client: PoolClient,
  taskId: string,
): Promise<void> {
  const history = await client.query(
    `SELECT 1 FROM ${host.executionsTable} WHERE task_id=$1 LIMIT 1`,
    [taskId],
  );
  if (history.rows[0]) {
    throw new TaskboardValidationError(
      'Task title and description cannot be changed after Agent execution starts; add a comment instead',
      'TASKBOARD_TASK_CONTENT_LOCKED',
    );
  }
}

export async function finalizeExecutionForArchivedTask(
  host: TaskboardArchiveGuardHost,
  client: PoolClient,
  task: TaskBoardTask,
  boardArchivedAt: string | undefined,
  execution: TaskBoardExecution,
  input: TaskboardExecutionCompletionInput,
): Promise<TaskBoardExecutionStartResult | null> {
  if (!task.archivedAt && !boardArchivedAt) return null;
  const archived = await client.query(
    `UPDATE ${host.executionsTable}
        SET status=$2, error=$3, finished_at=now(), updated_at=now(),
            reconcile_lease_id=NULL, reconcile_lease_expires_at=NULL
      WHERE run_id=$1 RETURNING *`,
    [execution.runId, input.status, optionalText(input.error)],
  );
  await client.query(
    `UPDATE ${host.executionOutboxTable} SET status='dispatched', lease_id=NULL,
            lease_expires_at=NULL, updated_at=now() WHERE run_id=$1`,
    [execution.runId],
  );
  return { task, execution: rowToExecution(archived.rows[0]) };
}

function activeRunError(): TaskboardValidationError {
  return new TaskboardValidationError(
    'Tasks with an active Agent execution cannot be archived',
    'TASKBOARD_EXECUTION_ACTIVE',
  );
}
