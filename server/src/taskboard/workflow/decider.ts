import type {
  TaskBoardExecutionPurpose,
  TaskBoardIntegrationCandidateState,
  TaskBoardStatus,
  TaskBoardTask,
} from '../../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from '../types.js';

export interface IntegrationV3ExecutionBinding {
  candidateId: string;
  candidateVersion: number;
  candidateRevision: number;
  candidateWorkRound: number;
  candidateWorkflowEpoch: string;
  candidateLaneEpoch: string;
  candidateHeadOid: string;
}

export interface IntegrationV3Facts {
  id: string;
  state: TaskBoardIntegrationCandidateState;
  version: number;
  currentRevision: number;
  workRound: number;
  workflowEpoch: string;
  laneEpoch: string;
  headOid?: string;
}

export interface WorkflowFacts {
  hasMergeFact: boolean;
  candidate?: IntegrationV3Facts;
  executionBinding?: IntegrationV3ExecutionBinding;
}

export type TransitionDecision = {
  toStatus?: TaskBoardStatus;
  candidateState?: TaskBoardIntegrationCandidateState;
  requestSystemReview?: boolean;
};

const TERMINAL_STATUSES = new Set<TaskBoardStatus>(['done', 'canceled']);

export function isIrreversibleMerged(task: TaskBoardTask, facts?: WorkflowFacts): boolean {
  return Boolean(task.mergedCommitOid) || facts?.hasMergeFact === true || facts?.candidate?.state === 'merged';
}

/**
 * Pure routing seam used by integrationTriggers. The trigger owns candidate
 * locking/beginNextWorkRound; this function only determines whether an Agent is
 * needed. Compose/check/merge states are deliberately system-owned.
 */
export function purposeForIntegrationV3Candidate(
  state: TaskBoardIntegrationCandidateState,
): 'work' | 'review' | undefined {
  if (state === 'needs_work' || state === 'working') return 'work';
  if (state === 'in_review') return 'review';
  return undefined;
}

export function isCurrentIntegrationV3Execution(
  candidate: IntegrationV3Facts,
  binding: IntegrationV3ExecutionBinding | undefined,
): boolean {
  return Boolean(binding
    && binding.candidateId === candidate.id
    && binding.candidateVersion === candidate.version
    && binding.candidateRevision === candidate.currentRevision
    && binding.candidateWorkRound === candidate.workRound
    && binding.candidateWorkflowEpoch === candidate.workflowEpoch
    && binding.candidateLaneEpoch === candidate.laneEpoch
    && (!candidate.headOid || binding.candidateHeadOid === candidate.headOid));
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
      const candidate = options.facts?.candidate;
      if (!candidate) {
        throw new TaskboardValidationError(
          'Workflow v3 integration dispatch requires the current candidate',
          'TASKBOARD_CANDIDATE_REQUIRED',
        );
      }
      const expected = purposeForIntegrationV3Candidate(candidate.state);
      if (!expected || purpose !== expected) {
        throw new TaskboardValidationError(
          purpose === 'merge'
            ? 'Workflow v3 never dispatches an Agent merge execution'
            : `Candidate ${candidate.state} is not dispatchable for ${purpose}`,
          purpose === 'merge' ? 'TASKBOARD_V3_AGENT_MERGE_FORBIDDEN' : 'TASKBOARD_CANDIDATE_EXECUTION_STATE_INVALID',
        );
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
  if (TERMINAL_STATUSES.has(task.status)
    || (isIrreversibleMerged(task, facts) && !completingMergedIntegration)) {
    throw new TaskboardValidationError('Terminal task cannot accept a transition', 'TASKBOARD_EXECUTION_FENCED');
  }
  if (task.kind === 'integration' && task.workflowVersion === 3) {
    const candidate = facts.candidate;
    if (!candidate || !isCurrentIntegrationV3Execution(candidate, facts.executionBinding)) {
      throw new TaskboardValidationError('Candidate execution is no longer current', 'TASKBOARD_EXECUTION_FENCED');
    }
    if (purposeForIntegrationV3Candidate(candidate.state) !== purpose) invalidTransition(task, purpose, status);
    if (purpose === 'work' && candidate.state === 'working') {
      if (status === 'in_review') return { requestSystemReview: true };
      if (status === 'blocked') return { toStatus: 'blocked', candidateState: 'blocked' };
    }
    if (purpose === 'review') {
      if (status === 'ready_to_merge') return { toStatus: status, candidateState: 'approved' };
      if (status === 'todo') return { toStatus: status, candidateState: 'needs_work' };
      if (status === 'in_review') return { toStatus: status, candidateState: 'in_review' };
      if (status === 'blocked') return { toStatus: status, candidateState: 'blocked' };
    }
    return invalidTransition(task, purpose, status);
  }
  if (purpose === 'work') {
    if (!['in_progress', 'todo'].includes(task.status)) invalidTransition(task, purpose, status);
    if (task.kind === 'advisory' && (status === 'todo' || status === 'blocked')) return { toStatus: status };
    if (task.kind !== 'advisory' && (status === 'in_review' || status === 'blocked')) return { toStatus: status };
  }
  if (purpose === 'review' && task.status === 'in_review') {
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
