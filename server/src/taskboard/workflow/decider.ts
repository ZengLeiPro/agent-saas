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
): 'work' | 'review' | 'merge' | undefined {
  if (status === 'todo' || status === 'in_progress') return 'work';
  if (status === 'in_review') return 'review';
  if (status === 'ready_to_merge') return 'merge';
  return undefined;
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
    if (task.workflowVersion === 3) {
      const expected = purposeForIntegrationAgentStatus(task.status);
      if (!expected || purpose !== expected) {
        throw new TaskboardValidationError('Integration Agent is not dispatchable for this purpose', 'TASKBOARD_INTEGRATION_AGENT_EXECUTION_STATE_INVALID');
      }
      return;
    }
    // Missing workflowVersion is legacy v2 by contract.
    if (purpose !== 'merge') {
      throw new TaskboardValidationError(
        'Integration tasks only accept merge execution',
        'TASKBOARD_INTEGRATION_PURPOSE_INVALID',
      );
    }
    if (!['todo', 'in_progress'].includes(task.status)) {
      throw new TaskboardValidationError(
        task.status === 'blocked'
          ? 'Blocked integration requires an explicit source-level resume decision'
          : 'Integration task is not dispatchable',
        task.status === 'blocked' ? 'TASKBOARD_RESUME_REQUIRED' : 'TASKBOARD_EXECUTION_STATUS_INVALID',
      );
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
  const completingMergedIntegration = task.kind === 'integration'
    && task.workflowVersion !== 3
    && purpose === 'merge'
    && status === 'done';
  if ((TERMINAL_STATUSES.has(task.status) && !completingMergedIntegration)
    || (isIrreversibleMerged(task, facts) && !completingMergedIntegration)) {
    throw new TaskboardValidationError('Terminal task cannot accept a transition', 'TASKBOARD_EXECUTION_FENCED');
  }
  if (purpose === 'work') {
    if (!['in_progress', 'todo'].includes(task.status)) invalidTransition(task, purpose, status);
    if (task.kind === 'advisory' && (status === 'todo' || status === 'blocked')) return { toStatus: status };
    if (task.kind !== 'advisory' && (status === 'in_review' || status === 'blocked')) return { toStatus: status };
  }
  if (purpose === 'review' && task.status === 'in_review') {
    if (task.kind === 'remediation' && status === 'ready_to_merge') return { toStatus: 'done' };
    const allowed = task.kind === 'remediation'
      ? ['done', 'todo', 'in_review', 'blocked']
      : ['ready_to_merge', 'todo', 'in_review', 'blocked'];
    if (allowed.includes(status)) return { toStatus: status };
  }
  if (purpose === 'merge' && task.kind === 'integration') {
    if (status === 'done' && facts.hasMergeFact) return { toStatus: status };
    if (status === 'in_progress' || status === 'blocked') return { toStatus: status };
  }
  return invalidTransition(task, purpose, status);
}

function invalidTransition(task: TaskBoardTask, purpose: TaskBoardExecutionPurpose, status: TaskBoardStatus): never {
  throw new TaskboardValidationError(
    `Status ${status} is invalid for ${task.kind ?? 'legacy delivery'} ${purpose} from ${task.status}`,
    'TASKBOARD_WORKFLOW_TRANSITION_INVALID',
  );
}
