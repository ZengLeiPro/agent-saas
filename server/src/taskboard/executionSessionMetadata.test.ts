import { describe, expect, it } from 'vitest';

import { reusableTaskboardSessionId, taskboardExecutionSessionDescriptor } from './executionSessionMetadata.js';

describe('taskboardExecutionSessionDescriptor', () => {
  it('marks v3 integration work and review sessions for the integration runtime', () => {
    expect(taskboardExecutionSessionDescriptor('integration', 'work', 'task-1')).toEqual({
      sessionPrefix: 'taskboard-integration-work',
      integrationMetadata: {
        taskboardIntegration: true,
        taskboardIntegrationRole: 'work',
        taskboardIntegrationTaskId: 'task-1',
        taskboardWorkflowVersion: 3,
      },
    });
    expect(taskboardExecutionSessionDescriptor('integration', 'review', 'task-1').sessionPrefix)
      .toBe('taskboard-integration-review');
  });

  it('preserves legacy prefixes and omits integration metadata for other sessions', () => {
    expect(taskboardExecutionSessionDescriptor('integration', 'merge', 'task-1')).toEqual({
      sessionPrefix: 'taskboard-integration-merge',
      integrationMetadata: {
        taskboardIntegration: true,
        taskboardIntegrationRole: 'merge',
        taskboardIntegrationTaskId: 'task-1',
        taskboardWorkflowVersion: 3,
      },
    });
    expect(taskboardExecutionSessionDescriptor('delivery', 'work', 'task-2')).toEqual({
      sessionPrefix: 'taskboard',
      integrationMetadata: {},
    });
  });

  it('keeps one durable integration identity while every review receives a fresh read-only session', () => {
    const executions: Array<{ purpose: 'work' | 'review' | 'merge'; sessionId: string }> = [
      { purpose: 'work', sessionId: 'session-A' },
    ];
    expect(reusableTaskboardSessionId('integration', 'work', executions)).toBe('session-A');
    expect(reusableTaskboardSessionId('integration', 'review', executions)).toBeUndefined();
    executions.push({ purpose: 'review', sessionId: 'session-B' });
    expect(reusableTaskboardSessionId('integration', 'work', executions)).toBe('session-A');
    expect(reusableTaskboardSessionId('integration', 'review', executions)).toBeUndefined();
    executions.push({ purpose: 'review', sessionId: 'session-C' });
    expect(reusableTaskboardSessionId('integration', 'merge', executions, 'session-A')).toBe('session-A');
    // The persisted rendezvous remains authoritative even if legacy executions contain another work session.
    executions.push({ purpose: 'work', sessionId: 'legacy-wrong-session' });
    expect(reusableTaskboardSessionId('integration', 'work', executions, 'session-A')).toBe('session-A');
    // cleanup runs inside the bound merge execution, so it observes the same A session.
    expect(reusableTaskboardSessionId('integration', 'merge', executions)).toBe('session-A');
  });
});
