import { describe, expect, it } from 'vitest';

import type { TaskBoardIntegrationPolicy } from './taskboard.js';

const policy: TaskBoardIntegrationPolicy = {
  schemaVersion: 1,
  enabled: true,
  revision: 'test',
  workflowVersion: 3,
  trigger: { mode: 'manual', allowedRoles: ['owner'] },
  batch: { maxTasks: 10, selection: 'priority_then_ready_at' },
  execution: {
    mergeMethod: 'squash',
    continueIndependentSources: true,
    autoResolveConflicts: true,
    maxAutomaticRemediationRounds: 2,
    maxTransientRetries: 3,
    requireGreenChecks: true,
    deleteRemoteBranch: false,
    deploy: false,
  },
};

// @ts-expect-error v2 is historical task data, not a writable integration policy version.
const legacyPolicy: TaskBoardIntegrationPolicy = { ...policy, workflowVersion: 2 };

const flaggedPolicy: TaskBoardIntegrationPolicy = {
  ...policy,
  // @ts-expect-error featureFlags is no longer part of the shared writable contract.
  featureFlags: { engineV3: true },
};

void legacyPolicy;
void flaggedPolicy;

describe('TaskBoardIntegrationPolicy writable contract', () => {
  it('contains only the Agent-first workflow version and no feature flags', () => {
    expect(policy.workflowVersion).toBe(3);
    expect(policy).not.toHaveProperty('featureFlags');
  });
});
