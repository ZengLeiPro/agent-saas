import { describe, expect, it, vi } from 'vitest';

import { GithubRepositoryProvider, repositorySubjectDigest } from './repositoryProvider.js';

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
});
