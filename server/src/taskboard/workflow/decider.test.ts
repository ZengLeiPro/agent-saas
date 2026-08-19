import { describe, expect, it } from 'vitest';

import type { TaskBoardTask } from '../../../../shared/src/types/taskboard.js';
import { executionFieldMigrationSql, resolveExecutionPurpose } from '../executionFields.js';
import { resolveWorkflowContract } from '../workflowContract.js';
import {
  assertExecutionRequestAllowed,
  decideResolution,
  type IntegrationV3ExecutionBinding,
  type IntegrationV3Facts,
  purposeForIntegrationV3Candidate,
} from './decider.js';

function task(overrides: Partial<TaskBoardTask> = {}): TaskBoardTask {
  return {
    id: 'task-1',
    boardId: 'board-1',
    identifier: 'TASK-1',
    kind: 'delivery',
    title: 'Task',
    description: '',
    status: 'in_review',
    priority: 'none',
    labels: [],
    sortOrder: 1,
    commentCount: 0,
    version: 3,
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

const candidate: IntegrationV3Facts = {
  id: 'candidate-1',
  state: 'working',
  version: 7,
  currentRevision: 3,
  workRound: 2,
  workflowEpoch: '11',
  laneEpoch: '5',
  headOid: 'head-3',
};

const binding: IntegrationV3ExecutionBinding = {
  candidateId: candidate.id,
  candidateVersion: candidate.version,
  candidateRevision: candidate.currentRevision,
  candidateWorkRound: candidate.workRound,
  candidateWorkflowEpoch: candidate.workflowEpoch,
  candidateLaneEpoch: candidate.laneEpoch,
  candidateHeadOid: candidate.headOid!,
};

describe('taskboard workflow decider incident replay', () => {
  it('TASK-69: merge fact absorbs stale_subject and blocked late resolutions', () => {
    const merged = task({ status: 'done', mergedCommitOid: 'abc123' });
    expect(decideResolution(merged, 'review', 'stale_subject', { hasMergeFact: true }))
      .toEqual({ kind: 'ignore', reason: 'merged_terminal' });
    expect(decideResolution(merged, 'review', 'blocked', { hasMergeFact: true }))
      .toEqual({ kind: 'ignore', reason: 'merged_terminal' });
    expect(() => assertExecutionRequestAllowed(merged, 'work')).toThrowError(
      expect.objectContaining({ code: 'TASKBOARD_TERMINAL_EXECUTION_FORBIDDEN' }),
    );
  });

  it('TASK-84: advisory completes without repository, PR, review, or integration capabilities', () => {
    const advisory = task({ kind: 'advisory', status: 'in_progress' });
    const contract = resolveWorkflowContract(advisory, 'work');
    expect(contract.allowedOutcomes).toEqual(['completed', 'blocked']);
    expect(contract.capabilities).toMatchObject({
      modifyTaskBranch: false,
      attachPullRequest: false,
      createFollowUpTask: false,
      merge: false,
    });
    expect(decideResolution(advisory, 'work', 'completed', { hasMergeFact: false }))
      .toEqual({ kind: 'apply', toStatus: 'todo' });
    expect(() => decideResolution(advisory, 'work', 'ready_for_review', { hasMergeFact: false }))
      .toThrowError(expect.objectContaining({ code: 'TASKBOARD_WORKFLOW_TRANSITION_INVALID' }));
  });

  it('integration comments/dispatch can only use merge and blocked requires explicit resume', () => {
    const integration = task({ kind: 'integration', status: 'todo' });
    expect(() => assertExecutionRequestAllowed(integration, 'work')).toThrowError(
      expect.objectContaining({ code: 'TASKBOARD_INTEGRATION_PURPOSE_INVALID' }),
    );
    expect(() => assertExecutionRequestAllowed({ ...integration, status: 'blocked' }, 'merge')).toThrowError(
      expect.objectContaining({ code: 'TASKBOARD_RESUME_REQUIRED' }),
    );
    expect(() => assertExecutionRequestAllowed(integration, 'merge')).not.toThrow();
  });

  it('remediation approval converges to done instead of ready_to_merge', () => {
    expect(decideResolution(
      task({ kind: 'remediation', status: 'in_review' }),
      'review',
      'approved',
      { hasMergeFact: false },
    )).toEqual({ kind: 'apply', toStatus: 'done' });
  });
});

describe('integration workflow v3 routing', () => {
  const integration = task({ kind: 'integration', workflowVersion: 3, status: 'in_progress' });

  it('installs an all-or-none execution fence binding for candidate credentials', () => {
    const ddl = executionFieldMigrationSql('tb_executions');
    for (const column of [
      'candidate_id', 'candidate_version', 'candidate_revision', 'candidate_work_round',
      'candidate_workflow_epoch', 'candidate_lane_epoch', 'candidate_head_oid',
    ]) expect(ddl).toContain(column);
    expect(ddl).toContain('tb_executions_candidate_binding_check');
  });

  it('routes only candidate work/review states and never routes Agent merge', () => {
    expect(purposeForIntegrationV3Candidate('needs_work')).toBe('work');
    expect(purposeForIntegrationV3Candidate('working')).toBe('work');
    expect(purposeForIntegrationV3Candidate('in_review')).toBe('review');
    expect(purposeForIntegrationV3Candidate('approved')).toBeUndefined();
    expect(resolveExecutionPurpose('in_progress', undefined, 'integration', 3, 'working')).toBe('work');
    expect(resolveExecutionPurpose('in_review', undefined, 'integration', 3, 'in_review')).toBe('review');
    expect(() => resolveExecutionPurpose('ready_to_merge', 'merge', 'integration', 3, 'approved'))
      .toThrowError(expect.objectContaining({ code: 'TASKBOARD_V3_AGENT_MERGE_FORBIDDEN' }));
    expect(() => assertExecutionRequestAllowed(integration, 'merge', { facts: { hasMergeFact: false, candidate } }))
      .toThrowError(expect.objectContaining({ code: 'TASKBOARD_V3_AGENT_MERGE_FORBIDDEN' }));
  });

  it('work completion requests review while preserving candidate revision credentials', () => {
    const contract = resolveWorkflowContract(integration, 'work', { candidateState: 'working' });
    expect(contract.capabilities.merge).toBe(false);
    expect(contract.requiredEvidence).toContain('candidate revision');
    expect(decideResolution(integration, 'work', 'ready_for_review', {
      hasMergeFact: false,
      candidate,
      executionBinding: binding,
    })).toEqual({ kind: 'apply', requestSystemReview: true });
  });

  it.each([
    ['approved', 'ready_to_merge', 'approved'],
    ['changes_requested', 'todo', 'needs_work'],
    ['stale_subject', 'todo', 'needs_work'],
    ['blocked', 'blocked', 'blocked'],
  ] as const)('binds review %s to the current candidate epoch', (outcome, toStatus, candidateState) => {
    const reviewCandidate = { ...candidate, state: 'in_review' as const };
    expect(decideResolution(integration, 'review', outcome, {
      hasMergeFact: false,
      candidate: reviewCandidate,
      executionBinding: binding,
    })).toEqual({ kind: 'apply', toStatus, candidateState });
  });

  it('absorbs late revision/epoch/head receipts instead of mutating authority', () => {
    for (const stale of [
      { ...binding, candidateRevision: 2 },
      { ...binding, candidateWorkflowEpoch: '10' },
      { ...binding, candidateLaneEpoch: '4' },
      { ...binding, candidateHeadOid: 'old-head' },
    ]) {
      expect(decideResolution(integration, 'work', 'ready_for_review', {
        hasMergeFact: false,
        candidate,
        executionBinding: stale,
      })).toEqual({ kind: 'ignore', reason: 'execution_superseded' });
    }
  });

  it('keeps workflowVersion=2 and omitted workflowVersion on legacy merge routing', () => {
    for (const workflowVersion of [2, undefined] as const) {
      const legacy = task({ kind: 'integration', workflowVersion, status: 'todo' });
      expect(resolveExecutionPurpose('todo', undefined, 'integration', 2)).toBe('merge');
      expect(() => assertExecutionRequestAllowed(legacy, 'merge')).not.toThrow();
      expect(resolveWorkflowContract(legacy).purpose).toBe('merge');
    }
  });
});
