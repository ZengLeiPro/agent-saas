import { describe, expect, it } from 'vitest';

import {
  RUNTIME_ISOLATION_POLICY_DIGEST,
  integrationRuntimeIsolationRequirement,
} from './runtimeIsolationEvidence.js';

const identity = { tenantId: 'tenant-1', runId: 'run-1', sessionId: 'session-1', workspaceId: 'workspace-1' };

describe('Integration runtime isolation requirement', () => {
  it.each(['work', 'review'])('binds Integration %s metadata to the actual raw run recipe', (role) => {
    expect(integrationRuntimeIsolationRequirement({
      taskboardIntegration: true,
      taskboardIntegrationRole: role,
      taskboardIntegrationTaskId: 'task-1',
    }, identity)).toEqual({
      ...identity, taskId: 'task-1', policyDigest: RUNTIME_ISOLATION_POLICY_DIGEST,
    });
  });

  it('does not affect ordinary runs', () => {
    expect(integrationRuntimeIsolationRequirement({ taskboardExecution: true }, identity)).toBeUndefined();
  });

  it('fails closed when marked Integration metadata lacks tenant/task binding', () => {
    expect(() => integrationRuntimeIsolationRequirement(
      { taskboardIntegration: true, taskboardIntegrationRole: 'work' },
      { runId: 'run-1', sessionId: 'session-1', workspaceId: 'workspace-1' },
    )).toThrow('RUNTIME_ISOLATION_REQUIREMENT_IDENTITY_MISSING');
  });
});
