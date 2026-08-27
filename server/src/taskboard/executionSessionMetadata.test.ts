import { describe, expect, it } from 'vitest';

import { reusableTaskboardSessionId, taskboardExecutionSessionDescriptor } from './executionSessionMetadata.js';

describe('taskboardExecutionSessionDescriptor', () => {
  it('uses one Integration session identity with standard runtime metadata', () => {
    expect(taskboardExecutionSessionDescriptor('integration', 'work', 'task-1')).toEqual({
      sessionPrefix: 'taskboard-integration',
      integrationMetadata: {
        taskboardIntegration: true,
        taskboardIntegrationRole: 'integration',
        taskboardIntegrationTaskId: 'task-1',
        taskboardWorkflowVersion: 3,
      },
    });
  });

  it('preserves ordinary Delivery session descriptors', () => {
    expect(taskboardExecutionSessionDescriptor('delivery', 'work', 'task-2')).toEqual({
      sessionPrefix: 'taskboard',
      integrationMetadata: {},
    });
  });

  it('always reuses the Integration durable session instead of creating Review/Merge sessions', () => {
    const executions: Array<{ purpose: 'work' | 'review' | 'merge'; sessionId: string }> = [
      { purpose: 'work', sessionId: 'session-A' },
    ];
    expect(reusableTaskboardSessionId('integration', 'work', executions)).toBe('session-A');
    expect(reusableTaskboardSessionId('integration', 'review', executions)).toBe('session-A');
    expect(reusableTaskboardSessionId('integration', 'merge', executions, 'session-A')).toBe('session-A');
    executions.push({ purpose: 'review', sessionId: 'legacy-review-session' });
    expect(reusableTaskboardSessionId('integration', 'work', executions, 'session-A')).toBe('session-A');
  });
});
