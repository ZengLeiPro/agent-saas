import { resolveGithubToken } from '../connectors/github.js';
import type { UserStore } from '../data/users/store.js';
import { GithubRepositoryProvider, type RepositoryProvider } from './repositoryProvider.js';
import type { IntegrationEngineV3ProviderFacts, IntegrationEngineV3ProviderHost } from './integrationEngineV3.js';
import type { IntegrationProviderOperationRecord, IntegrationProviderReconcileResult } from './integrationProviderOperations.js';
import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import type { PgTaskboardStore } from './store.js';

export function configureTaskboardGithubRepositoryProvider(
  store: Pick<PgTaskboardStore, 'setRepositoryProvider'> | undefined,
  userStore: Pick<UserStore, 'findById'> | undefined,
  githubContext: Parameters<typeof resolveGithubToken>[0],
  tokenMode?: 'github_app' | 'restricted_pat',
): RepositoryProvider | undefined {
  if (!store) return undefined;
  const provider = new GithubRepositoryProvider({
    resolveToken: async (repository, credentialOwnerId) => {
      const user = userStore?.findById(credentialOwnerId);
      if (!user || user.disabled) return undefined;
      const mode = tokenMode;
      // v3 write credentials are repository-bound by deployment mode. App mode only
      // accepts immutable numeric GitHub ids; PAT is an explicit compatibility mode.
      if (mode === 'github_app' && !/^github-id:\d+$/.test(repository.repositoryId)) return undefined;
      if (mode === 'restricted_pat'
        && repository.repositoryId.toLowerCase() !== `github:${repository.owner}/${repository.name}`.toLowerCase()) return undefined;
      if (mode !== 'github_app' && mode !== 'restricted_pat') return undefined;
      return resolveGithubToken(githubContext, {
        userId: user.id,
        username: user.username,
        tenantId: user.tenantId,
      });
    },
  });
  store.setRepositoryProvider(provider);
  return provider;
}

/** Adapts the existing GitHub provider to authoritative v3 facts and merge operations. */
export class RepositoryProviderIntegrationEngineV3Adapter implements IntegrationEngineV3ProviderHost {
  constructor(private readonly provider: RepositoryProvider) {}

  async readFacts(repository: TaskBoardRepositoryConfig, providerPullRequestId: string, credentialOwnerId: string): Promise<IntegrationEngineV3ProviderFacts> {
    if (!this.provider.getReference) throw new Error('Repository provider cannot resolve candidate tree facts');
    const pull = await this.provider.getPullRequest(repository, providerPullRequestId, credentialOwnerId);
    const [head, gates] = await Promise.all([
      this.provider.getReference(repository, pull.headRef, credentialOwnerId),
      this.provider.getRequiredGateCapabilities
        ? this.provider.getRequiredGateCapabilities(repository, pull.baseRef, credentialOwnerId)
        : Promise.resolve({ known: false, requiredChecks: [], mergeQueueRequired: false, unsupportedRules: ['required-gates-unavailable'] }),
    ]);
    return {
      repositoryId: repository.repositoryId,
      providerPullRequestId: pull.providerPullRequestId,
      state: pull.state,
      baseBranch: pull.baseRef,
      baseOid: pull.baseOid,
      headOid: pull.headOid,
      treeOid: head.treeOid,
      requiredChecksKnown: pull.requiredChecksKnown === true && gates.known,
      requiredChecks: pull.requiredChecks,
      unsupportedRules: gates.unsupportedRules,
      mergeQueueRequired: gates.mergeQueueRequired,
      ...(pull.mergeCommitOid ? { mergeCommitOid: pull.mergeCommitOid } : {}),
      // Git commit tree for a clean merge/squash is the approved head tree. Providers that
      // cannot preserve/verify this must leave facts unknown and the engine fails closed.
      ...(pull.state === 'merged' ? { mergedTreeOid: head.treeOid } : {}),
    };
  }

  async merge(repository: TaskBoardRepositoryConfig, input: { providerPullRequestId: string; expectedHeadOid: string; method: 'merge'|'squash'|'rebase'; operationKey: string }, credentialOwnerId: string): Promise<Record<string, unknown>> {
    const receipt = await this.provider.mergePullRequest(repository, { ...input, requestId: input.operationKey }, credentialOwnerId);
    if (!receipt.merged || !receipt.mergedCommitOid) throw new Error(receipt.message ?? 'Provider did not return a verified merge receipt');
    return { ...receipt.raw, providerRequestId: receipt.providerRequestId, mergedCommitOid: receipt.mergedCommitOid };
  }

  async reconcileMerge(operation: IntegrationProviderOperationRecord, repository: TaskBoardRepositoryConfig, credentialOwnerId: string): Promise<IntegrationProviderReconcileResult> {
    const providerPullRequestId = String(operation.command.providerPullRequestId ?? '');
    if (!providerPullRequestId) return { status: 'mismatch', detail: 'Provider operation has no pull request binding' };
    try {
      const facts = await this.readFacts(repository, providerPullRequestId, credentialOwnerId);
      if (facts.state !== 'merged' || !facts.mergeCommitOid) return { status: 'not_found', detail: 'Pull request is not merged' };
      const expectedTree = String(operation.expected.treeOid ?? '');
      if (!facts.mergedTreeOid || facts.mergedTreeOid !== expectedTree) {
        return { status: 'mismatch', detail: 'Merged tree does not match the approved candidate tree', evidence: { mergedTreeOid: facts.mergedTreeOid, expectedTree } };
      }
      return { status: 'succeeded', receipt: { providerPullRequestId, mergedCommitOid: facts.mergeCommitOid, mergedTreeOid: facts.mergedTreeOid } };
    } catch (error) {
      return { status: 'indeterminate', detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
