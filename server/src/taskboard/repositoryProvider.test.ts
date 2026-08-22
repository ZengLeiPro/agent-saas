import { describe, expect, it, vi } from 'vitest';

import { GithubRepositoryProvider, repositorySubjectDigest } from './repositoryProvider.js';

const unavailablePolicyFeature = 'Upgrade to GitHub Pro or make this repository public to enable this feature.';
const repository = {
  provider: 'github' as const,
  repositoryId: 'github:acme/app',
  owner: 'acme',
  name: 'app',
  baseBranch: 'main',
  allowForkPullRequest: false as const,
};

describe('GithubRepositoryProvider', () => {
  it('builds a stable reviewed subject from provider facts', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        number: 42,
        state: 'open',
        merged: false,
        draft: false,
        mergeable: true,
        mergeable_state: 'clean',
        head: { ref: 'feat/x', sha: 'head-oid', repo: { full_name: 'acme/app' } },
        base: { ref: 'main', sha: 'base-oid', repo: { full_name: 'acme/app' } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        check_runs: [
          { name: 'test', status: 'completed', conclusion: 'success' },
          { name: 'lint', status: 'in_progress', conclusion: null },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ statuses: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contexts: ['test', 'lint'] }), { status: 200 }));
    const provider = new GithubRepositoryProvider({
      resolveToken: async () => 'secret-token',
      fetchImpl,
    });

    const snapshot = await provider.getPullRequest(repository, '42', 'owner-user');

    expect(snapshot).toMatchObject({
      providerPullRequestId: '42',
      number: 42,
      headOid: 'head-oid',
      baseOid: 'base-oid',
      requiredChecks: [
        { name: 'lint', status: 'pending' },
        { name: 'test', status: 'success' },
      ],
    });
    expect(snapshot.subjectDigest).toBe(repositorySubjectDigest({
      repositoryId: repository.repositoryId,
      providerPullRequestId: '42',
      number: 42,
      headOid: 'head-oid',
      baseRef: 'main',
      baseOid: 'base-oid',
    }));
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer secret-token' });
  });

  it('fails closed when GitHub check facts cannot be read', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        number: 42, state: 'open', merged: false, draft: false, mergeable: true,
        head: { ref: 'feat/x', sha: 'head-oid', repo: { full_name: 'acme/app' } },
        base: { ref: 'main', sha: 'base-oid', repo: { full_name: 'acme/app' } },
      }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 }));
    const provider = new GithubRepositoryProvider({ resolveToken: async () => 'secret-token', fetchImpl });

    const snapshot = await provider.getPullRequest(repository, '42', 'owner-user');
    expect(snapshot.requiredChecks).toContainEqual({ name: 'github:checks-unavailable', status: 'failure' });
  });

  it('uses observed checks when private-repository policy APIs are explicitly unavailable', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        number: 42, state: 'open', merged: false, draft: false, mergeable: true,
        head: { ref: 'feat/x', sha: 'head-oid', repo: { full_name: 'acme/app' } },
        base: { ref: 'main', sha: 'base-oid', repo: { full_name: 'acme/app' } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ statuses: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: unavailablePolicyFeature }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: unavailablePolicyFeature }), { status: 403 }));
    const provider = new GithubRepositoryProvider({ resolveToken: async () => 'token', fetchImpl });

    const snapshot = await provider.getPullRequest(repository, '42', 'owner-user');

    expect(snapshot.requiredChecksKnown).toBe(true);
    expect(snapshot.requiredChecks).toEqual([{ name: 'CI', status: 'success' }]);
  });

  it('rejects pull requests outside the configured base or repository', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      number: 42, state: 'open', merged: false, draft: false, mergeable: true,
      head: { ref: 'feat/x', sha: 'head-oid', repo: { full_name: 'fork/app' } },
      base: { ref: 'release', sha: 'base-oid', repo: { full_name: 'acme/app' } },
    }), { status: 200 }));
    const provider = new GithubRepositoryProvider({ resolveToken: async () => 'secret-token', fetchImpl });

    await expect(provider.getPullRequest(repository, '42', 'owner-user')).rejects.toThrow('outside the board policy');
  });

  it('uses expected head oid and idempotency key for server-side merge', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      merged: true,
      sha: 'merge-oid',
      message: 'Pull Request successfully merged',
    }), { status: 200 }));
    const provider = new GithubRepositoryProvider({
      resolveToken: async () => 'secret-token',
      fetchImpl,
    });

    const receipt = await provider.mergePullRequest(repository, {
      providerPullRequestId: '42',
      expectedHeadOid: 'head-oid',
      method: 'squash',
      requestId: 'operation-1',
    }, 'owner-user');

    expect(receipt).toMatchObject({ merged: true, mergedCommitOid: 'merge-oid', providerRequestId: 'operation-1' });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      sha: 'head-oid',
      merge_method: 'squash',
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ 'Idempotency-Key': 'operation-1' });
  });

  it('fails closed when an empty required-check response cannot be confirmed by rulesets', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        number: 42, state: 'open', merged: false, draft: false, mergeable: true,
        head: { ref: 'feat/x', sha: 'head-oid', repo: { full_name: 'acme/app' } },
        base: { ref: 'main', sha: 'base-oid', repo: { full_name: 'acme/app' } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ check_runs: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ statuses: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contexts: [], checks: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'rulesets forbidden' }), { status: 403 }));
    const provider = new GithubRepositoryProvider({ resolveToken: async () => 'token', fetchImpl });

    const snapshot = await provider.getPullRequest(repository, '42', 'owner-user');

    expect(snapshot.requiredChecksKnown).toBe(false);
    expect(snapshot.requiredChecks).toEqual([{ name: 'github:checks-unavailable', status: 'failure' }]);
  });

  it('treats unavailable private-repository policy features as an authoritative absence of provider gates', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({ message: unavailablePolicyFeature }), { status: 403 }));
    const provider = new GithubRepositoryProvider({ resolveToken: async () => 'token', fetchImpl });

    const capabilities = await provider.getRequiredGateCapabilities(repository, 'main', 'owner-user');

    expect(capabilities).toEqual({
      known: true,
      requiredChecks: [],
      mergeQueueRequired: false,
      unsupportedRules: [],
    });
  });

  it('reads required gate identities and merge-queue capability from protection and rulesets', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ checks: [{ context: 'test', app_id: 7 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 99 }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 99,
        rules: [
          { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint', integration_id: 8 }] } },
          { type: 'merge_queue' },
        ],
      }), { status: 200 }));
    const provider = new GithubRepositoryProvider({ resolveToken: async () => 'token', fetchImpl });

    const capabilities = await provider.getRequiredGateCapabilities(repository, 'main', 'owner-user');

    expect(capabilities).toEqual({
      known: true,
      requiredChecks: [{ name: 'lint', appId: 8 }, { name: 'test', appId: 7 }],
      mergeQueueRequired: true,
      unsupportedRules: [],
    });
  });

  it('reconciles an already-created integration branch without creating it again', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { sha: 'base-oid' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'base-oid', tree: { sha: 'tree-oid' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { sha: 'base-oid' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'base-oid', tree: { sha: 'tree-oid' } }), { status: 200 }));
    const provider = new GithubRepositoryProvider({ resolveToken: async () => 'token', fetchImpl });

    const receipt = await provider.ensureIntegrationBranch(repository, {
      ref: 'integration/task-1', expectedBaseOid: 'base-oid', expectedBaseTreeOid: 'tree-oid', operationKey: 'branch:task-1:r1',
    }, 'owner-user');

    expect(receipt).toMatchObject({ created: false, ref: 'integration/task-1', oid: 'base-oid', treeOid: 'tree-oid' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  it('accepts an existing integration branch only when its OID is backed by a durable push intent', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { sha: 'new-base' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'new-base', tree: { sha: 'new-tree' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { sha: 'trusted-old' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'trusted-old', tree: { sha: 'old-tree' } }), { status: 200 }));
    const provider = new GithubRepositoryProvider({ resolveToken: async () => 'token', fetchImpl });

    const receipt = await provider.ensureIntegrationBranch(repository, {
      ref: 'integration/task-1', expectedBaseOid: 'new-base', expectedBaseTreeOid: 'new-tree',
      trustedExistingOids: ['trusted-old'], operationKey: 'branch:task-1:r1',
    }, 'owner-user');

    expect(receipt).toMatchObject({ created: false, oid: 'trusted-old', treeOid: 'old-tree' });
    expect(fetchImpl.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  it('rejects an existing integration branch that matches neither base nor durable push intent', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { sha: 'new-base' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'new-base', tree: { sha: 'new-tree' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { sha: 'third-party' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'third-party', tree: { sha: 'third-tree' } }), { status: 200 }));
    const provider = new GithubRepositoryProvider({ resolveToken: async () => 'token', fetchImpl });

    await expect(provider.ensureIntegrationBranch(repository, {
      ref: 'integration/task-1', expectedBaseOid: 'new-base', expectedBaseTreeOid: 'new-tree',
      trustedExistingOids: ['trusted-old'], operationKey: 'branch:task-1:r1',
    }, 'owner-user')).rejects.toThrow('durable push intent');
  });

  it('does not recreate a missing branch after an Integration PR is already bound', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { sha: 'new-base' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'new-base', tree: { sha: 'new-tree' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }));
    const provider = new GithubRepositoryProvider({ resolveToken: async () => 'token', fetchImpl });

    await expect(provider.ensureIntegrationBranch(repository, {
      ref: 'integration/task-1', expectedBaseOid: 'new-base', expectedBaseTreeOid: 'new-tree',
      existingRequired: true, trustedExistingOids: ['trusted-old'], operationKey: 'branch:task-1:r1',
    }, 'owner-user')).rejects.toThrow('Bound integration branch is missing');
    expect(fetchImpl.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  it('rejects branch creation when the prepared base has drifted', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { sha: 'new-base' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'new-base', tree: { sha: 'new-tree' } }), { status: 200 }));
    const provider = new GithubRepositoryProvider({ resolveToken: async () => 'token', fetchImpl });

    await expect(provider.ensureIntegrationBranch(repository, {
      ref: 'integration/task-1', expectedBaseOid: 'old-base', expectedBaseTreeOid: 'old-tree', operationKey: 'branch:task-1:r1',
    }, 'owner-user')).rejects.toThrow('base ref changed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns the unique existing Integration PR instead of creating a duplicate', async () => {
    const existing = {
      number: 81,
      head: { ref: 'integration/task-1', sha: 'candidate-oid' },
      base: { ref: 'main', sha: 'base-oid' },
    };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { sha: 'candidate-oid' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'candidate-oid', tree: { sha: 'candidate-tree' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { sha: 'base-oid' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'base-oid', tree: { sha: 'base-tree' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([existing]), { status: 200 }));
    const provider = new GithubRepositoryProvider({ resolveToken: async () => 'token', fetchImpl });

    const receipt = await provider.ensureIntegrationPullRequest(repository, {
      headRef: 'integration/task-1', baseRef: 'main', expectedHeadOid: 'candidate-oid', title: 'Integration task 1', body: 'sources', operationKey: 'pr:task-1',
    }, 'owner-user');

    expect(receipt).toMatchObject({ created: false, providerPullRequestId: '81', headOid: 'candidate-oid' });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  it('returns workflow, job, step and controlled failure-log references for the exact PR head', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        number: 42, state: 'open', merged: false, draft: false, mergeable: true,
        head: { ref: 'feat/x', sha: 'head-oid', repo: { full_name: 'acme/app' } },
        base: { ref: 'main', sha: 'base-oid', repo: { full_name: 'acme/app' } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        check_runs: [{ name: 'Build & Check', status: 'completed', conclusion: 'failure' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ statuses: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contexts: ['Build & Check'] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workflow_runs: [{
        id: 501, name: 'CI', event: 'pull_request', status: 'completed', conclusion: 'failure',
        head_sha: 'head-oid', run_started_at: '2026-08-22T08:00:00Z', updated_at: '2026-08-22T08:05:00Z',
      }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [{
        id: 701, name: 'Build & Check', status: 'completed', conclusion: 'failure',
        steps: [{ number: 4, name: 'Run tests', status: 'completed', conclusion: 'failure' }],
      }] }), { status: 200 }));
    const provider = new GithubRepositoryProvider({ resolveToken: async () => 'token', fetchImpl });

    const inspection = await provider.inspectPullRequest(repository, '42', 'owner-user');

    expect(inspection).toMatchObject({
      repositoryId: repository.repositoryId,
      headOid: 'head-oid',
      workflowRuns: [{
        id: '501', headOid: 'head-oid',
        jobs: [{ id: '701', failureLogRef: 'github-job:701', steps: [{ name: 'Run tests', conclusion: 'failure' }] }],
      }],
    });
  });

  it('reads a bounded workflow job log through the server-side credential', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('failure details', { status: 200 }));
    const provider = new GithubRepositoryProvider({ resolveToken: async () => 'token', fetchImpl });

    await expect(provider.getWorkflowJobLog(repository, '701', 'owner-user')).resolves.toBe('failure details');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/acme/app/actions/jobs/701/logs');
    await expect(provider.getWorkflowJobLog(repository, '../701', 'owner-user')).rejects.toThrow('Invalid GitHub workflow job id');
  });

  it('fails closed when multiple Integration PRs exist for one branch', async () => {
    const pulls = [81, 82].map((number) => ({ number, head: { ref: 'integration/task-1', sha: 'candidate-oid' }, base: { ref: 'main' } }));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(pulls), { status: 200 }));
    const provider = new GithubRepositoryProvider({ resolveToken: async () => 'token', fetchImpl });

    await expect(provider.findIntegrationPullRequest(repository, {
      headRef: 'integration/task-1', baseRef: 'main', expectedHeadOid: 'candidate-oid',
    }, 'owner-user')).rejects.toThrow('More than one Integration PR');
  });
});
