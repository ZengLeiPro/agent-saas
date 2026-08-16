import type { PoolClient } from 'pg';

import type {
  TaskBoardExecution,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import {
  hasSuccessfulContinuationSince,
  nextTaskColumnSortOrder,
  type TaskboardContinuationStoreHost,
} from './continuationStore.js';
import { TaskboardValidationError, type TaskboardExecutionCompletionInput, type TaskboardIdentity } from './types.js';

interface ExecutionCompletionHost extends TaskboardContinuationStoreHost {
  executionOutboxTable: string;
}

export async function applyExecutionTaskCompletion(
  host: ExecutionCompletionHost,
  client: PoolClient,
  identity: TaskboardIdentity,
  task: TaskBoardTask,
  execution: TaskBoardExecution,
  executionCreatedAt: string | Date,
  input: TaskboardExecutionCompletionInput,
): Promise<boolean> {
  const succeeded = input.status === 'succeeded'
    || (execution.purpose === 'work'
      && await hasSuccessfulContinuationSince(host, client, task.id, executionCreatedAt));
  const reviewFailure = execution.purpose === 'review' && !succeeded;
  const targetStatus = execution.purpose === 'work'
    ? (succeeded ? 'in_review' : 'blocked')
    : reviewFailure ? 'blocked' : undefined;
  const shouldMove = execution.purpose === 'work'
    ? task.status === 'in_progress'
    : reviewFailure && ['in_review', 'ready_to_merge', 'todo'].includes(task.status);
  if (!targetStatus || !shouldMove) return succeeded;

  const sortOrder = await nextTaskColumnSortOrder(
    host,
    client,
    identity,
    task.boardId,
    task.id,
    targetStatus,
  );
  await client.query(
    `UPDATE ${host.tasksTable}
        SET status=$2, sort_order=$3, completed_at=NULL,
            version=version+1, updated_at=now()
      WHERE id=$1`,
    [task.id, targetStatus, sortOrder],
  );
  return succeeded;
}

export async function enqueueAutomaticReview(
  host: ExecutionCompletionHost,
  client: PoolClient,
  task: TaskBoardTask,
  execution: TaskBoardExecution,
  executionSucceeded: boolean,
  review: TaskboardExecutionCompletionInput['reviewExecution'],
): Promise<void> {
  if (!review) return;
  if (
    execution.purpose !== 'work'
    || !executionSucceeded
    || review.purpose !== 'review'
    || review.allowWorkFromCurrentStatus
    || review.executionOwnerUserId !== execution.requestedBy
  ) {
    throw new TaskboardValidationError('Invalid automatic review execution');
  }
  if (task.status !== 'in_progress' && task.status !== 'in_review') return;

  await client.query(
    `INSERT INTO ${host.executionsTable}
       (id, task_id, run_id, session_id, status, purpose, requested_by)
     VALUES ($1,$2,$3,$4,'queued','review',$5)`,
    [review.executionId, task.id, review.runId, review.sessionId, execution.requestedBy],
  );
  await client.query(
    `INSERT INTO ${host.executionOutboxTable}
       (run_id, execution_id, payload)
     VALUES ($1,$2,$3::jsonb)`,
    [review.runId, review.executionId, JSON.stringify(review.dispatch)],
  );
}
