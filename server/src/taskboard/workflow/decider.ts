import type {
  TaskBoardExecutionPurpose,
  TaskBoardStatus,
  TaskBoardTask,
} from '../../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from '../types.js';

export interface WorkflowFacts {
  hasMergeFact: boolean;
}

export type TransitionDecision = {
  toStatus?: TaskBoardStatus;
};

const TERMINAL_STATUSES = new Set<TaskBoardStatus>(['done', 'canceled']);

export function isIrreversibleMerged(task: TaskBoardTask, facts?: WorkflowFacts): boolean {
  return Boolean(task.mergedCommitOid) || facts?.hasMergeFact === true;
}

export function purposeForIntegrationAgentStatus(
  status: TaskBoardStatus,
): 'work' | undefined {
  return status === 'todo' || status === 'in_progress' ? 'work' : undefined;
}

export function assertIntegrationExecutionMigrated(task: Pick<TaskBoardTask, 'kind' | 'workflowVersion'>): void {
  if (task.kind === 'integration' && task.workflowVersion !== 3) {
    throw new TaskboardValidationError(
      'Integration task is awaiting Agent-first workflow migration',
      'TASKBOARD_INTEGRATION_MIGRATION_REQUIRED',
    );
  }
}

export function assertExecutionRequestAllowed(
  task: TaskBoardTask,
  purpose: TaskBoardExecutionPurpose,
  options: { allowInitialInProgress?: boolean; facts?: WorkflowFacts } = {},
): void {
  if (TERMINAL_STATUSES.has(task.status) || isIrreversibleMerged(task, options.facts)) {
    throw new TaskboardValidationError(
      'Terminal or merged tasks cannot be dispatched again',
      'TASKBOARD_TERMINAL_EXECUTION_FORBIDDEN',
    );
  }
  if (task.kind === 'integration') {
    assertIntegrationExecutionMigrated(task);
    if (purpose !== 'work' || !purposeForIntegrationAgentStatus(task.status)) {
      throw new TaskboardValidationError('Integration Agent only runs one durable work execution', 'TASKBOARD_INTEGRATION_AGENT_EXECUTION_STATE_INVALID');
    }
    return;
  }
  if (purpose === 'merge') {
    throw new TaskboardValidationError(
      'Only integration tasks can use merge execution',
      'TASKBOARD_MERGE_REQUIRES_INTEGRATION',
    );
  }
  if (purpose === 'review') {
    if (task.kind === 'advisory' || task.status !== 'in_review') {
      throw new TaskboardValidationError(
        'Only delivery or remediation tasks in review can use review execution',
        'TASKBOARD_REVIEW_REQUIRES_IN_REVIEW',
      );
    }
    return;
  }
  if (task.status === 'blocked') {
    throw new TaskboardValidationError(
      'Blocked work requires an explicit resume decision',
      'TASKBOARD_RESUME_REQUIRED',
    );
  }
  if (task.status !== 'todo' && !(options.allowInitialInProgress && task.status === 'in_progress')) {
    throw new TaskboardValidationError(
      'Only todo tasks can use work execution',
      'TASKBOARD_EXECUTION_REQUIRES_TODO',
    );
  }
}

export function decideTransition(
  task: TaskBoardTask,
  purpose: TaskBoardExecutionPurpose,
  status: TaskBoardStatus,
  facts: WorkflowFacts,
): TransitionDecision {
  assertIntegrationExecutionMigrated(task);
  if (TERMINAL_STATUSES.has(task.status) || isIrreversibleMerged(task, facts)) {
    throw new TaskboardValidationError('Terminal task cannot accept a transition', 'TASKBOARD_EXECUTION_FENCED');
  }
  if (purpose === 'work') {
    if (!['in_progress', 'todo'].includes(task.status)) invalidTransition(task, purpose, status);
    if (task.kind === 'integration' && (status === 'done' || status === 'blocked')) return { toStatus: status };
    if (task.kind === 'advisory' && (status === 'todo' || status === 'blocked')) return { toStatus: status };
    if (task.kind !== 'advisory' && task.kind !== 'integration'
      && (status === 'in_review' || status === 'blocked')) return { toStatus: status };
  }
  if (purpose === 'review' && task.status === 'in_review') {
    if (task.kind === 'remediation' && status === 'ready_to_merge') return { toStatus: 'done' };
    const allowed = task.kind === 'remediation'
      ? ['done', 'todo', 'in_review', 'blocked']
      : ['ready_to_merge', 'todo', 'in_review', 'blocked'];
    if (allowed.includes(status)) return { toStatus: status };
  }
  return invalidTransition(task, purpose, status);
}

function invalidTransition(task: TaskBoardTask, purpose: TaskBoardExecutionPurpose, status: TaskBoardStatus): never {
  throw new TaskboardValidationError(
    `Status ${status} is invalid for ${task.kind ?? 'legacy delivery'} ${purpose} from ${task.status}`,
    'TASKBOARD_WORKFLOW_TRANSITION_INVALID',
  );
}
