import type { TaskBoardStatus, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from './types.js';

const MANUAL_REQUEUE_STATUSES = new Set<TaskBoardStatus>(['ready_to_merge', 'done', 'canceled']);
const WORKFLOW_PROTECTED_STATUSES = new Set<TaskBoardStatus>(['in_progress', 'in_review', 'ready_to_merge', 'blocked', 'done']);

export function isTaskPlanningTransition(from: TaskBoardStatus, to: TaskBoardStatus): boolean {
  return from !== to && [from, to].every((status) => status === 'backlog' || status === 'todo');
}

export function isManualTaskRequeue(task: TaskBoardTask, status: TaskBoardStatus): boolean {
  return status === 'todo' && MANUAL_REQUEUE_STATUSES.has(task.status);
}

export function assertManualTaskRequeueAllowed(task: TaskBoardTask): void {
  if (task.kind !== 'delivery' && task.kind !== 'advisory') {
    throw new TaskboardValidationError('Only delivery and advisory tasks can be returned to todo', 'TASKBOARD_PROTECTED_TRANSITION');
  }
  if (task.mergeEligibility === 'claimed' || task.mergeEligibility === 'merged' || task.mergedCommitOid) {
    throw new TaskboardValidationError('Claimed or merged delivery tasks cannot be returned to todo', 'TASKBOARD_PROTECTED_TRANSITION');
  }
}

export function assertManualTaskMoveAllowed(task: TaskBoardTask, status: TaskBoardStatus): void {
  if (task.kind === 'integration') {
    throw new TaskboardValidationError('Integration state transitions are controlled by the integration workflow', 'TASKBOARD_PROTECTED_TRANSITION');
  }
  if (isManualTaskRequeue(task, status)) return assertManualTaskRequeueAllowed(task);
  if (WORKFLOW_PROTECTED_STATUSES.has(status) || WORKFLOW_PROTECTED_STATUSES.has(task.status)) {
    throw new TaskboardValidationError('This state transition requires a workflow command', 'TASKBOARD_PROTECTED_TRANSITION');
  }
}

export function manualTaskRequeueResetSql(enabled: boolean): string {
  return enabled ? `,
                workflow_epoch=t.workflow_epoch+1,
                next_action='none',
                next_action_revision=t.next_action_revision+1,
                resume_context=NULL,
                reviewed_subject_digest=NULL,
                provider_ci_inspection_id=NULL,
                provider_ci_execution_id=NULL,
                provider_ci_purpose=NULL,
                provider_ci_head_oid=NULL,
                provider_ci_status=NULL,
                provider_ci_inspected_at=NULL` : '';
}

export function taskMoveChangeType(sameStatus: boolean, manuallyRequeued: boolean): string {
  return sameStatus ? 'task.reordered' : manuallyRequeued ? 'task.requeued' : 'task.transitioned';
}
