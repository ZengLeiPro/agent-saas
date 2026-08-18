import type {
  TaskBoardExecutionPurpose,
  TaskBoardStatus,
  TaskBoardTask,
} from '../../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from '../types.js';

export interface WorkflowFacts {
  hasMergeFact: boolean;
}

export type ResolutionDecision =
  | { kind: 'apply'; toStatus?: TaskBoardStatus }
  | { kind: 'ignore'; reason: 'merged_terminal' | 'execution_superseded' };

const TERMINAL_STATUSES = new Set<TaskBoardStatus>(['done', 'canceled']);

export function isIrreversibleMerged(task: TaskBoardTask, facts?: WorkflowFacts): boolean {
  return Boolean(task.mergedCommitOid) || facts?.hasMergeFact === true;
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

export function decideResolution(
  task: TaskBoardTask,
  purpose: TaskBoardExecutionPurpose,
  outcome: string,
  facts: WorkflowFacts,
): ResolutionDecision {
  if (isIrreversibleMerged(task, facts)) return { kind: 'ignore', reason: 'merged_terminal' };
  if (TERMINAL_STATUSES.has(task.status)) {
    throw new TaskboardValidationError(
      'Terminal task cannot accept another resolution',
      'TASKBOARD_TERMINAL_RESOLUTION_FORBIDDEN',
    );
  }
  if (purpose === 'work') {
    if (!['in_progress', 'todo'].includes(task.status)) invalidResolution(task, purpose, outcome);
    if (task.kind === 'advisory') {
      if (outcome === 'completed') return { kind: 'apply', toStatus: 'done' };
      if (outcome === 'blocked') return { kind: 'apply', toStatus: 'blocked' };
      invalidResolution(task, purpose, outcome);
    }
    if (outcome === 'ready_for_review') return { kind: 'apply', toStatus: 'in_review' };
    if (outcome === 'blocked') return { kind: 'apply', toStatus: 'blocked' };
  }
  if (purpose === 'review') {
    if (task.status !== 'in_review') invalidResolution(task, purpose, outcome);
    if (outcome === 'approved') {
      return { kind: 'apply', toStatus: task.kind === 'remediation' ? 'done' : 'ready_to_merge' };
    }
    if (outcome === 'changes_requested') return { kind: 'apply', toStatus: 'todo' };
    if (outcome === 'stale_subject') return { kind: 'apply', toStatus: 'in_review' };
    if (outcome === 'blocked') return { kind: 'apply', toStatus: 'blocked' };
  }
  if (purpose === 'merge') {
    if (task.kind !== 'integration') invalidResolution(task, purpose, outcome);
    if (outcome === 'progress') return { kind: 'apply' };
    if (outcome === 'completed') return { kind: 'apply', toStatus: 'done' };
    if (outcome === 'needs_human') return { kind: 'apply', toStatus: 'blocked' };
  }
  return invalidResolution(task, purpose, outcome);
}

function invalidResolution(
  task: TaskBoardTask,
  purpose: TaskBoardExecutionPurpose,
  outcome: string,
): never {
  throw new TaskboardValidationError(
    `Outcome ${outcome} is invalid for ${task.kind ?? 'legacy delivery'} ${purpose} from ${task.status}`,
    'TASKBOARD_WORKFLOW_TRANSITION_INVALID',
  );
}
