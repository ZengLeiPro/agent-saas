import type { TaskBoardStatus, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from './types.js';

const MANUAL_REQUEUE_STATUSES = new Set<TaskBoardStatus>(['ready_to_merge', 'done', 'canceled']);

export function isManualTaskRequeue(task: TaskBoardTask, status: TaskBoardStatus): boolean {
  return status === 'todo' && MANUAL_REQUEUE_STATUSES.has(task.status);
}

export function assertManualTaskRequeueAllowed(task: TaskBoardTask): void {
  if (task.kind !== 'delivery' && task.kind !== 'advisory') {
    throw new TaskboardValidationError(
      'Only delivery and advisory tasks can be returned to todo',
      'TASKBOARD_PROTECTED_TRANSITION',
    );
  }
  if (task.mergeEligibility === 'claimed' || task.mergeEligibility === 'merged' || task.mergedCommitOid) {
    throw new TaskboardValidationError(
      'Claimed or merged delivery tasks cannot be returned to todo',
      'TASKBOARD_PROTECTED_TRANSITION',
    );
  }
}
