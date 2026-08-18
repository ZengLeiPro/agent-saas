import { describe, expect, it } from 'vitest';

import type { TaskBoardTask } from '../../../../shared/src/types/taskboard.js';
import { resolveWorkflowContract } from '../workflowContract.js';
import {
  assertExecutionRequestAllowed,
  decideResolution,
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
      .toEqual({ kind: 'apply', toStatus: 'done' });
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
