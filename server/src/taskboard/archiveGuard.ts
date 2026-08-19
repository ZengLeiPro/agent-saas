import type { PoolClient } from 'pg';

import type { TaskBoardExecution, TaskBoardExecutionStartResult, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { optionalText, rowToExecution } from './storeHelpers.js';
import { TaskboardValidationError, type TaskboardExecutionCompletionInput } from './types.js';

export interface TaskboardArchiveGuardHost {
  tasksTable: string;
  executionsTable: string;
  continuationOutboxTable: string;
  executionOutboxTable: string;
  /** Present on the real store; optional for focused hosts and legacy tests. */
  integrationSourcesTable?: string;
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
  await assertNoIntegrationV3State(host, client, { boardId });
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
  await assertNoIntegrationV3State(host, client, { taskId });
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

async function assertNoIntegrationV3State(
  host: TaskboardArchiveGuardHost,
  client: PoolClient,
  scope: { taskId?: string; boardId?: string },
): Promise<void> {
  if (!host.integrationSourcesTable) return;
  const root = host.integrationSourcesTable.endsWith('_sources')
    ? host.integrationSourcesTable.slice(0, -'_sources'.length)
    : host.integrationSourcesTable;
  const candidates = `${root}_candidates`;
  const operations = `${root}_provider_operations_v3`;
  const outbox = `${root}_requests_outbox_v3`;
  const active = await client.query(
    `SELECT 1 FROM ${candidates} c JOIN ${host.tasksTable} t ON t.id=c.integration_task_id
      WHERE (($1::text IS NOT NULL AND t.id=$1) OR ($2::text IS NOT NULL AND t.board_id=$2))
        AND (c.state NOT IN ('merged','canceled')
          OR EXISTS (SELECT 1 FROM ${operations} o WHERE o.candidate_id=c.id AND o.state IN ('prepared','executing','unknown'))
          OR EXISTS (SELECT 1 FROM ${outbox} q WHERE q.candidate_id=c.id AND q.status IN ('pending','processing')))
      LIMIT 1`,
    [scope.taskId ?? null, scope.boardId ?? null],
  );
  if (active.rows[0]) throw new TaskboardValidationError(
    'Workflow v3 provider and outbox state must be terminal before archive or delete',
    'TASKBOARD_INTEGRATION_V3_ACTIVE',
  );
}

function activeRunError(): TaskboardValidationError {
  return new TaskboardValidationError(
    'Tasks with an active Agent execution cannot be archived',
    'TASKBOARD_EXECUTION_ACTIVE',
  );
}
