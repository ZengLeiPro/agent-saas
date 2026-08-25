import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import type { IntegrationProviderOperationRecord } from './integrationProviderOperations.js';
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

const mergeOperation: IntegrationProviderOperationRecord = {
  id: 'operation-1',
  operationKey: 'integration:merge_pull_request:candidate-1:r1:operation-key',
  intentDigest: 'intent-digest',
  kind: 'merge_pull_request',
  repositoryId: repository.repositoryId,
  fence: {
    workflowEpoch: 3,
    laneEpoch: 9,
    candidateId: 'candidate-1',
    candidateRevision: 1,
    executionId: 'merge-execution-1',
  },
  expected: { baseOid: 'approved-base', treeOid: 'approved-tree' },
  command: { providerPullRequestId: '42', expectedHeadOid: 'head-1', method: 'squash' },
  state: 'unknown',
  attemptCount: 1,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
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

  it('keeps board fallback identities stable when GitHub declares no required checks', async () => {
    const fallbackRepository = { ...repository, ciPolicy: { requiredChecks: [{ name: 'Board CI', appId: 9 }] } };
    const provider = {
      getPullRequest: vi.fn(async () => ({
        providerPullRequestId: '42', number: 42, state: 'open' as const, draft: false,
        headRef: 'integration/task-1', headOid: 'head-1', baseRef: 'main', baseOid: 'base-1',
        mergeable: true, requiredChecksKnown: true, requiredChecksConfigured: true,
        requiredChecks: [{ name: 'Board CI', appId: 9, status: 'success' as const }], subjectDigest: 'sha256:subject',
      })),
      getCommit: vi.fn(async (_repository, oid: string) => ({ oid, treeOid: `${oid}-tree` })),
      getReference: vi.fn(async (_repository, ref: string) => ({ ref, oid: 'current-main', treeOid: 'main-tree' })),
      getRequiredGateCapabilities: vi.fn(async () => ({
        known: true, requiredChecks: [], mergeQueueRequired: false, unsupportedRules: [],
      })),
      mergePullRequest: vi.fn(),
    } as unknown as RepositoryProvider;
    const adapter = new RepositoryProviderIntegrationEngineV3Adapter(provider);

    const facts = await adapter.readFacts(fallbackRepository, '42', 'owner-1');

    expect(facts).toMatchObject({ requiredChecksKnown: true, requiredChecksConfigured: true });
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

  it('binds a successful reconciled merge receipt to the durable operation key', async () => {
    const adapter = new RepositoryProviderIntegrationEngineV3Adapter({} as RepositoryProvider);
    vi.spyOn(adapter, 'readFacts').mockResolvedValue({
      repositoryId: repository.repositoryId,
      providerPullRequestId: '42',
      state: 'merged',
      draft: false,
      mergeable: null,
      baseBranch: 'main',
      baseOid: 'approved-base',
      headOid: 'head-1',
      treeOid: 'approved-tree',
      requiredChecksKnown: true,
      requiredChecks: [],
      unsupportedRules: [],
      mergeQueueRequired: false,
      mergeCommitOid: 'merge-commit-1',
      mergedTreeOid: 'approved-tree',
    });

    await expect(adapter.reconcileMerge(mergeOperation, repository, 'owner-1')).resolves.toEqual({
      status: 'succeeded',
      receipt: {
        providerRequestId: mergeOperation.operationKey,
        providerPullRequestId: '42',
        mergedCommitOid: 'merge-commit-1',
        mergedTreeOid: 'approved-tree',
        baseOid: 'approved-base',
      },
    });
  });

  it('fails reconciliation when authoritative Provider facts do not match the operation target', async () => {
    const adapter = new RepositoryProviderIntegrationEngineV3Adapter({} as RepositoryProvider);
    vi.spyOn(adapter, 'readFacts').mockResolvedValue({
      repositoryId: repository.repositoryId,
      providerPullRequestId: '43',
      state: 'merged',
      draft: false,
      mergeable: null,
      baseBranch: 'main',
      baseOid: 'approved-base',
      headOid: 'head-1',
      treeOid: 'approved-tree',
      requiredChecksKnown: true,
      requiredChecks: [],
      unsupportedRules: [],
      mergeQueueRequired: false,
      mergeCommitOid: 'merge-commit-1',
      mergedTreeOid: 'approved-tree',
    });

    await expect(adapter.reconcileMerge(mergeOperation, repository, 'owner-1')).resolves.toMatchObject({
      status: 'mismatch',
      evidence: {
        providerPullRequestId: '43',
        expectedProviderPullRequestId: '42',
      },
    });
  });
});
