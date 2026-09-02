import { describe, expect, it } from 'vitest';

import {
  TASKBOARD_DEFAULT_MERGE_PROMPT,
  TASKBOARD_DEFAULT_PROMPT,
  TASKBOARD_DEFAULT_REVIEW_PROMPT,
  TASKBOARD_DEFAULT_WORK_PROMPT,
  TASKBOARD_STAGE_DEFAULT_PROMPTS,
  type TaskBoardIntegrationPolicy,
} from './taskboard.js';

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

describe('taskboard default prompts', () => {
  it('uses distinct, repository-agnostic prompts for all execution stages', () => {
    expect(new Set(Object.values(TASKBOARD_STAGE_DEFAULT_PROMPTS))).toHaveProperty('size', 3);
    expect(TASKBOARD_STAGE_DEFAULT_PROMPTS).toEqual({
      work: TASKBOARD_DEFAULT_WORK_PROMPT,
      review: TASKBOARD_DEFAULT_REVIEW_PROMPT,
      merge: TASKBOARD_DEFAULT_MERGE_PROMPT,
    });
    for (const prompt of [TASKBOARD_DEFAULT_PROMPT, ...Object.values(TASKBOARD_STAGE_DEFAULT_PROMPTS)]) {
      expect(prompt).not.toContain('code/agent-saas');
      expect(prompt).not.toContain('目标分支为 main');
      expect(prompt).not.toContain('execution.integration_candidate.push');
      expect(prompt).not.toContain('execution.review_subject.record');
    }
    expect(TASKBOARD_DEFAULT_WORK_PROMPT).toContain('### Advisory Work');
    expect(TASKBOARD_DEFAULT_WORK_PROMPT).toContain('### Remediation Work');
    expect(TASKBOARD_DEFAULT_REVIEW_PROMPT).toContain('Remediation 通过时 finish(done)');
    expect(TASKBOARD_DEFAULT_MERGE_PROMPT).toContain('deleteRemoteBranch=false');
  });
});

describe('TaskBoardIntegrationPolicy writable contract', () => {
  it('contains only the Agent-first workflow version and no feature flags', () => {
    expect(policy.workflowVersion).toBe(3);
    expect(policy).not.toHaveProperty('featureFlags');
  });
});
