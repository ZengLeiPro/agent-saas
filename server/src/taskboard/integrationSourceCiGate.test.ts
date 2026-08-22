import { describe, expect, it, vi } from 'vitest';

import type { RepositoryPullRequestSnapshot } from './repositoryProvider.js';
import { assertIntegrationSourcesProviderReady } from './integrationSourceCiGate.js';

const repository = {
  provider: 'github' as const, repositoryId: 'github:acme/repo', owner: 'acme', name: 'repo',
  baseBranch: 'main', allowForkPullRequest: false as const,
};
const row = {
  identifier: 'TASK-1', provider_pull_request_id: '42', head_oid: 'head-42', base_oid: 'base-42',
  reviewed_subject_digest: 'subject-42', review_execution_id: 'review-1',
  provider_ci_status: 'success', provider_ci_purpose: 'review', provider_ci_head_oid: 'head-42',
  provider_ci_execution_id: 'review-1',
};
const current: RepositoryPullRequestSnapshot = {
  providerPullRequestId: '42', number: 42, state: 'open', draft: false,
  headRef: 'fix/task-1', headOid: 'head-42', baseRef: 'main', baseOid: 'base-42', mergeable: true,
  requiredChecksKnown: true, requiredChecks: [{ name: 'Build & Check', status: 'success' }],
  subjectDigest: 'subject-42',
};

function provider(snapshot: RepositoryPullRequestSnapshot = current) {
  return { getPullRequest: vi.fn(async () => snapshot), mergePullRequest: vi.fn() };
}

describe('Integration source admission CI gate', () => {
  it('re-reads Provider and accepts only current reviewed green sources', async () => {
    const value = provider();
    await expect(assertIntegrationSourcesProviderReady(value, repository, 'owner-1', [row])).resolves.toBeUndefined();
    expect(value.getPullRequest).toHaveBeenCalledWith(repository, '42', 'owner-1');
  });

  it('rejects missing review inspection before Provider access', async () => {
    const value = provider();
    await expect(assertIntegrationSourcesProviderReady(value, repository, 'owner-1', [
      { ...row, provider_ci_execution_id: 'old-review' },
    ])).rejects.toMatchObject({ code: 'TASKBOARD_CI_INSPECTION_REQUIRED' });
    expect(value.getPullRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['pending', 'TASKBOARD_CI_PENDING'],
    ['failure', 'TASKBOARD_CI_FAILED'],
  ] as const)('rejects a source whose current Provider checks are %s', async (status, code) => {
    const value = provider({ ...current, requiredChecks: [{ name: 'Build & Check', status }] });
    await expect(assertIntegrationSourcesProviderReady(value, repository, 'owner-1', [row]))
      .rejects.toMatchObject({ code });
  });

  it('fails closed when the Provider is unavailable', async () => {
    await expect(assertIntegrationSourcesProviderReady(undefined, repository, 'owner-1', [row]))
      .rejects.toMatchObject({ code: 'TASKBOARD_CI_UNAVAILABLE' });
  });
});
