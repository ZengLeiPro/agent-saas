import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import type { RepositoryProvider } from './repositoryProvider.js';
import { RepositoryProviderIntegrationEngineV3Adapter } from './repositoryRuntime.js';

const repository: TaskBoardRepositoryConfig = {
  provider: 'github',
  repositoryId: 'github:acme/app',
  owner: 'acme',
  name: 'app',
  baseBranch: 'main',
  allowForkPullRequest: false,
};

describe('RepositoryProviderIntegrationEngineV3Adapter', () => {
  it('binds provider facts to the current base ref instead of the PR creation snapshot', async () => {
    const provider = {
      getPullRequest: vi.fn(async () => ({
        providerPullRequestId: '42',
        number: 42,
        state: 'open' as const,
        draft: true,
        headRef: 'integration/task-1',
        headOid: 'head-1',
        baseRef: 'main',
        baseOid: 'stale-pr-base',
        mergeable: false,
        requiredChecksKnown: true,
        requiredChecks: [{ name: 'CI', status: 'success' as const }],
        subjectDigest: 'sha256:subject',
      })),
      getCommit: vi.fn(async (_repository, oid: string) => ({ oid, treeOid: `${oid}-tree` })),
      getReference: vi.fn(async (_repository, ref: string) => ({ ref, oid: 'current-main', treeOid: 'main-tree' })),
      getRequiredGateCapabilities: vi.fn(async () => ({
        known: true,
        requiredChecks: [{ name: 'CI' }],
        mergeQueueRequired: false,
        unsupportedRules: [],
      })),
      mergePullRequest: vi.fn(),
    } as unknown as RepositoryProvider;
    const adapter = new RepositoryProviderIntegrationEngineV3Adapter(provider);

    const facts = await adapter.readFacts(repository, '42', 'owner-1');

    expect(facts).toMatchObject({
      baseBranch: 'main',
      baseOid: 'current-main',
      headOid: 'head-1',
      treeOid: 'head-1-tree',
      draft: true,
      mergeable: false,
    });
    expect(provider.getCommit).toHaveBeenCalledWith(repository, 'head-1', 'owner-1');
    expect(provider.getReference).toHaveBeenCalledWith(repository, 'main', 'owner-1');
  });

  it('fails closed when required-check identities change between Provider reads', async () => {
    const provider = {
      getPullRequest: vi.fn(async () => ({
        providerPullRequestId: '42', number: 42, state: 'open' as const, draft: false,
        headRef: 'integration/task-1', headOid: 'head-1', baseRef: 'main', baseOid: 'base-1',
        mergeable: true, requiredChecksKnown: true,
        requiredChecks: [{ name: 'CI', appId: 1, status: 'success' as const }], subjectDigest: 'sha256:subject',
      })),
      getCommit: vi.fn(async (_repository, oid: string) => ({ oid, treeOid: `${oid}-tree` })),
      getReference: vi.fn(async (_repository, ref: string) => ({ ref, oid: 'current-main', treeOid: 'main-tree' })),
      getRequiredGateCapabilities: vi.fn(async () => ({
        known: true,
        requiredChecks: [{ name: 'CI', appId: 1 }, { name: 'Security', appId: 2 }],
        mergeQueueRequired: false,
        unsupportedRules: [],
      })),
      mergePullRequest: vi.fn(),
    } as unknown as RepositoryProvider;
    const adapter = new RepositoryProviderIntegrationEngineV3Adapter(provider);

    const facts = await adapter.readFacts(repository, '42', 'owner-1');

    expect(facts.requiredChecksKnown).toBe(false);
    expect(facts.unsupportedRules).toContain('required-check-identities-changed');
  });

  it('resolves the merged tree from the provider merge commit instead of the former head branch', async () => {
    const provider = {
      getPullRequest: vi.fn(async () => ({
        providerPullRequestId: '42', number: 42, state: 'merged' as const, draft: false,
        headRef: 'integration/task-1', headOid: 'a'.repeat(40), baseRef: 'main', baseOid: 'b'.repeat(40),
        mergeCommitOid: 'c'.repeat(40), mergeable: null, requiredChecksKnown: true,
        requiredChecks: [], subjectDigest: 'sha256:subject',
      })),
      getCommit: vi.fn(async (_repository, oid: string) => ({ oid, treeOid: oid === 'c'.repeat(40) ? 'merged-tree' : 'head-tree' })),
      getReference: vi.fn(async (_repository, ref: string) => ({ ref, oid: 'current-main', treeOid: 'main-tree' })),
      getRequiredGateCapabilities: vi.fn(async () => ({
        known: true, requiredChecks: [], mergeQueueRequired: false, unsupportedRules: [],
      })),
      mergePullRequest: vi.fn(),
    } as unknown as RepositoryProvider;
    const adapter = new RepositoryProviderIntegrationEngineV3Adapter(provider);

    const facts = await adapter.readFacts(repository, '42', 'owner-1');

    expect(facts).toMatchObject({
      state: 'merged',
      headOid: 'a'.repeat(40),
      treeOid: 'head-tree',
      mergeCommitOid: 'c'.repeat(40),
      mergedTreeOid: 'merged-tree',
    });
  });
});
