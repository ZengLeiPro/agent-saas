import { describe, expect, it } from 'vitest';

import {
  deriveBackgroundRuntimeIsolationRequirement,
  parseBackgroundTaskMetadata,
} from '../runtime/background/backgroundTaskMetadata.js';
import { deriveRuntimeIsolationRequirement } from '../runtime/runtimeIsolationEvidence.js';

describe('deriveRuntimeIsolationRequirement', () => {
  it('retains task/policy identity while rebinding a child run and session', () => {
    const parent = {
      tenantId: 'tenant-1',
      taskId: 'task-1',
      runId: 'parent-run',
      sessionId: 'parent-session',
      workspaceId: 'workspace-1',
      policyDigest: 'policy-1',
    };

    expect(deriveRuntimeIsolationRequirement(parent, {
      runId: 'child-run',
      sessionId: 'child-session',
      workspaceId: 'workspace-1',
    })).toEqual({
      ...parent,
      runId: 'child-run',
      sessionId: 'child-session',
    });
  });

  it('keeps non-attested child runs unchanged', () => {
    expect(deriveRuntimeIsolationRequirement(undefined, {
      runId: 'child-run',
      sessionId: 'child-session',
      workspaceId: 'workspace-1',
    })).toBeUndefined();
  });

  it('round-trips the requirement through durable background metadata before rebinding', () => {
    const requirement = {
      tenantId: 'tenant-1', taskId: 'task-1', runId: 'parent-run',
      sessionId: 'parent-session', workspaceId: 'workspace-1', policyDigest: 'policy-1',
    };
    const metadata = parseBackgroundTaskMetadata({ metadata: {
      backgroundTask: true, taskType: 'agent', parentRunId: 'parent-run', parentSessionId: 'parent-session',
      parentToolCallId: 'call-1', description: 'test', modelRef: 'model-1', cwd: '/workspace',
      workspaceId: 'workspace-1', prompt: 'test', agentType: 'general', includeCompanyInfo: false,
      runtimeIsolationRequirement: requirement,
    } } as never);

    expect(metadata && deriveBackgroundRuntimeIsolationRequirement(metadata, {
      runId: 'background-run', sessionId: 'background-session', workspaceId: 'workspace-1',
    })).toEqual({ ...requirement, runId: 'background-run', sessionId: 'background-session' });
  });
});
