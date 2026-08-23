import { describe, expect, it } from 'vitest';

import type { TaskBoardIntegrationPolicy, TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import { clearBoardCiPolicyForRepositoryChange } from './ciPolicy.js';

const repository = (repositoryId: string): TaskBoardRepositoryConfig => ({
  provider: 'github', repositoryId, owner: 'acme', name: repositoryId, baseBranch: 'main', allowForkPullRequest: false,
});
const policy: TaskBoardIntegrationPolicy = {
  schemaVersion: 1, enabled: true, revision: 'r1', ciPolicy: { requiredChecks: [{ name: 'old-repo-ci' }] },
  trigger: { mode: 'manual', allowedRoles: ['owner'] }, batch: { maxTasks: 10, selection: 'priority_then_ready_at' },
  execution: { mergeMethod: 'squash', continueIndependentSources: true, autoResolveConflicts: true, maxAutomaticRemediationRounds: 2, maxTransientRetries: 3, requireGreenChecks: true, deleteRemoteBranch: false, deploy: false },
};

describe('clearBoardCiPolicyForRepositoryChange', () => {
  it('clears a fallback whenever repository identity changes', () => {
    expect(clearBoardCiPolicyForRepositoryChange(repository('repo-old'), repository('repo-new'), policy))
      .toEqual({ policy: expect.not.objectContaining({ ciPolicy: expect.anything() }), cleared: true });
  });

  it('preserves an explicitly configured fallback when a repository is first attached', () => {
    expect(clearBoardCiPolicyForRepositoryChange(undefined, repository('repo-new'), policy))
      .toEqual({ policy, cleared: false });
  });

  it('preserves a fallback for changes within the same repository identity', () => {
    expect(clearBoardCiPolicyForRepositoryChange(repository('repo-1'), { ...repository('repo-1'), baseBranch: 'release' }, policy))
      .toEqual({ policy, cleared: false });
  });
});
