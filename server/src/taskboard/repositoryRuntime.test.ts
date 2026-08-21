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
        draft: false,
        headRef: 'integration/task-1',
        headOid: 'head-1',
        baseRef: 'main',
        baseOid: 'stale-pr-base',
        mergeable: true,
        requiredChecksKnown: true,
        requiredChecks: [{ name: 'CI', status: 'success' as const }],
        subjectDigest: 'sha256:subject',
      })),
      getReference: vi.fn(async (_repository, ref: string) => ref === 'main'
        ? { ref, oid: 'current-main', treeOid: 'main-tree' }
        : { ref, oid: 'head-1', treeOid: 'head-tree' }),
      getRequiredGateCapabilities: vi.fn(async () => ({
        known: true,
        requiredChecks: [],
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
      treeOid: 'head-tree',
    });
    expect(provider.getReference).toHaveBeenCalledWith(repository, 'main', 'owner-1');
  });
});
