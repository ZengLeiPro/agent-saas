import { describe, expect, it } from 'vitest';

import type { TaskBoardIntegrationPolicy } from '../../../shared/src/types/taskboard.js';
import { integrationPolicyNextRunAt } from './integrationPolicySchedule.js';

function policy(cron: string, timezone = 'Asia/Shanghai'): TaskBoardIntegrationPolicy {
  return {
    schemaVersion: 1,
    enabled: true,
    revision: 'policy-1',
    workflowVersion: 3,
    trigger: { mode: 'scheduled', cron, timezone },
    batch: { maxTasks: 10, selection: 'priority_then_ready_at' },
    execution: {
      mergeMethod: 'squash',
      continueIndependentSources: true,
      autoResolveConflicts: true,
      maxAutomaticRemediationRounds: 2,
      maxTransientRetries: 3,
      deleteRemoteBranch: false,
      deploy: false,
    },
  };
}

describe('integration policy schedule initialization', () => {
  it('anchors the first scheduled occurrence when the policy is saved', () => {
    const now = Date.parse('2026-09-02T01:49:58+08:00');
    expect(integrationPolicyNextRunAt(policy('50 1 * * *'), now)?.toISOString())
      .toBe('2026-09-01T17:50:00.000Z');
  });
});
