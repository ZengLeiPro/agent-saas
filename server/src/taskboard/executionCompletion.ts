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
  // Candidate transitions are protocol-driven and epoch fenced. Legacy
  // completion callbacks (including late callbacks) must never project a v3
  // integration task status.
  if (task.kind === 'integration' && task.workflowVersion === 3) {
    return input.status === 'succeeded';
  }
  if (execution.protocolVersion === 2) {
    return input.status === 'succeeded';
  }
  if (task.mergedCommitOid || task.status === 'done' || task.status === 'canceled') {
    return input.status === 'succeeded';
  }
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

export async function enqueueAutomaticResume(
  host: ExecutionCompletionHost,
  client: PoolClient,
  task: TaskBoardTask,
  execution: TaskBoardExecution,
  resume: TaskboardExecutionCompletionInput['resumeExecution'],
): Promise<void> {
  if (!resume) return;
  if (
    execution.protocolVersion !== 2
    || resume.purpose !== execution.purpose
    || resume.executionOwnerUserId !== execution.requestedBy
    || task.status === 'done'
    || task.status === 'canceled'
  ) {
    throw new TaskboardValidationError('Invalid automatic resume execution');
  }
  await enqueueExecution(host, client, task.id, resume);
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
  if (task.kind === 'integration' && task.workflowVersion === 3) {
    throw new TaskboardValidationError(
      'Workflow v3 review must be requested by integrationTriggers after candidate reconciliation',
      'TASKBOARD_V3_REVIEW_TRIGGER_REQUIRED',
    );
  }
  if (
    execution.purpose !== 'work'
    || !executionSucceeded
    || review.purpose !== 'review'
    || review.executionOwnerUserId !== execution.requestedBy
  ) {
    throw new TaskboardValidationError('Invalid automatic review execution');
  }
  if (task.status !== 'in_progress' && task.status !== 'in_review') return;

  await enqueueExecution(host, client, task.id, review);
}

async function enqueueExecution(
  host: ExecutionCompletionHost,
  client: PoolClient,
  taskId: string,
  claim: TaskboardExecutionCompletionInput['reviewExecution'],
): Promise<void> {
  if (!claim) return;
  await client.query(
    `INSERT INTO ${host.executionsTable}
       (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,requested_by)
     VALUES ($1,$2,$3,$4,'queued',$5,$6,$7,$8)`,
    [
      claim.executionId,
      taskId,
      claim.runId,
      claim.sessionId,
      claim.purpose,
      claim.trigger,
      claim.protocolVersion ?? 2,
      claim.executionOwnerUserId,
    ],
  );
  await client.query(
    `INSERT INTO ${host.executionOutboxTable}(run_id,execution_id,payload)
     VALUES ($1,$2,$3::jsonb)`,
    [claim.runId, claim.executionId, JSON.stringify(claim.dispatch)],
  );
}
