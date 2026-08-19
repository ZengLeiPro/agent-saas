import { describe, expect, it } from 'vitest';

import { taskboardExecutionSessionDescriptor } from './executionSessionMetadata.js';

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
      sessionPrefix: 'taskboard-merge',
      integrationMetadata: {},
    });
    expect(taskboardExecutionSessionDescriptor('delivery', 'work', 'task-2')).toEqual({
      sessionPrefix: 'taskboard',
      integrationMetadata: {},
    });
  });
});
