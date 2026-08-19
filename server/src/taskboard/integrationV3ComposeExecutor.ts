import { createHash } from 'node:crypto';

import type { TaskBoardIntegrationCandidateSourceSnapshot, TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import { canonicalGithubRepositoryUrl, type RepositoryProvider } from './repositoryProvider.js';
import { syncRepositoryWorkspace, type RepositoryWorkspaceSyncHost } from './repositoryWorkspaceSync.js';
import type { IntegrationV3ComposeExecutor, IntegrationV3WorkerCurrent } from './integrationV3Worker.js';

export interface IntegrationV3ComposeContext {
  repository: TaskBoardRepositoryConfig;
  credentialOwnerId: string;
  tenantId: string;
  repositoryPath: string;
  worktreePath: string;
  sources: TaskBoardIntegrationCandidateSourceSnapshot[];
  workExecutionId?: string;
}

export interface IntegrationV3ComposeHost extends RepositoryWorkspaceSyncHost {
  resolveContext(current: Required<IntegrationV3WorkerCurrent>): Promise<IntegrationV3ComposeContext>;
  /** Exact server-owned push. Must CAS the trusted integration ref; undefined means disabled fail-closed. */
  pushIntegrationHead?(input: {
    context: IntegrationV3ComposeContext;
    branch: string;
    expectedOldOid: string;
    headOid: string;
    candidateId: string;
    revision: number;
    integrationTaskId: string;
    laneEpoch: number;
    workflowEpoch: number;
  }): Promise<void>;
  bindPullRequest(candidateId: string, expectedVersion: number, providerPullRequestId: string): Promise<void>;
}

/** Deterministic local compose: origin/<base>, frozen heads in source_order, one stable commit. */
export class DefaultIntegrationV3ComposeExecutor implements IntegrationV3ComposeExecutor {
  constructor(private readonly host: IntegrationV3ComposeHost, private readonly provider: RepositoryProvider) {}

  async compose(current: Required<IntegrationV3WorkerCurrent>) {
    const context = await this.host.resolveContext(current);
    if (!this.host.pushIntegrationHead) throw new IntegrationV3ComposeDisabledError('Exact integration push service is not registered');
    if (!this.provider.ensureIntegrationBranch || !this.provider.ensureIntegrationPullRequest || !this.provider.getReference) {
      throw new IntegrationV3ComposeDisabledError('Repository provider does not support integration branch/PR composition');
    }
    if (current.candidate.providerPullRequestId) {
      // The first compose leaves the deterministic commit checked out. PR binding advances
      // candidate CAS without appending the revision, so normalize the clean controlled
      // worktree back to its durable base before the mandatory fetch/sync and recomposition.
      const status = await git(this.host, context.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
      if (status.stdout.length > 0) throw new Error('Integration worktree is dirty after pull request binding');
      await git(this.host, context.worktreePath, ['reset', '--hard', current.revision.baseOid]);
    }
    const sync = await syncRepositoryWorkspace(this.host, {
      repositoryPath: context.repositoryPath,
      worktreePath: context.worktreePath,
      baseBranch: current.candidate.baseBranch,
      integrationBranch: current.candidate.branch,
      controlledRemoteUrl: canonicalGithubRepositoryUrl(context.repository),
    });
    await git(this.host, context.worktreePath, ['reset', '--hard', sync.baseOid]);
    const ordered = [...context.sources].sort((a, b) => a.order - b.order);
    for (const source of ordered) {
      // A delivery PR may contain multiple commits; compose its frozen base..head range in source order.
      try {
        await git(this.host, context.worktreePath, ['cherry-pick', '--no-commit', `${source.frozenBaseOid}..${source.frozenHeadOid}`]);
      } catch (error) {
        await this.host.runGit({ cwd: context.worktreePath, args: ['cherry-pick', '--abort'] }).catch(() => undefined);
        throw new IntegrationV3ComposeConflictError(
          `Frozen source ${source.integrationSourceId} conflicts at ${source.frozenHeadOid}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const treeOid = singleOid(await git(this.host, context.worktreePath, ['write-tree']));
    const timestamp = new Date(current.candidate.createdAt).toISOString();
    const message = `Integration candidate ${current.candidate.id} revision ${current.candidate.currentRevision + 1}\n\nSource-Set: ${digestSources(ordered)}\n`;
    const commit = await this.host.runGit({
      cwd: context.worktreePath,
      args: ['commit-tree', treeOid, '-p', sync.baseOid, '-m', message],
      env: {
        GIT_AUTHOR_NAME: 'Integration Worker',
        GIT_AUTHOR_EMAIL: 'integration-worker@localhost',
        GIT_AUTHOR_DATE: timestamp,
        GIT_COMMITTER_NAME: 'Integration Worker',
        GIT_COMMITTER_EMAIL: 'integration-worker@localhost',
        GIT_COMMITTER_DATE: timestamp,
      },
    });
    if (commit.exitCode !== 0) throw new Error(commit.stderr || 'git commit-tree failed');
    const headOid = singleOid(commit);
    await git(this.host, context.worktreePath, ['reset', '--hard', headOid]);

    const branchReceipt = current.candidate.providerPullRequestId
      ? await this.provider.getReference(context.repository, current.candidate.branch, context.credentialOwnerId)
      : await this.provider.ensureIntegrationBranch(context.repository, {
        ref: current.candidate.branch,
        expectedBaseOid: sync.baseOid,
        expectedBaseTreeOid: singleOid(await git(this.host, context.worktreePath, ['rev-parse', `${sync.baseOid}^{tree}`])),
        operationKey: operationKey(current.candidate.id, current.candidate.currentRevision, 'branch'),
      }, context.credentialOwnerId);
    await this.host.pushIntegrationHead({
      context, branch: current.candidate.branch, expectedOldOid: branchReceipt.oid, headOid,
      candidateId: current.candidate.id, revision: current.candidate.currentRevision,
      integrationTaskId: current.candidate.integrationTaskId,
      laneEpoch: Number(current.candidate.laneEpoch), workflowEpoch: Number(current.candidate.workflowEpoch),
    });
    const remote = await this.provider.getReference(context.repository, current.candidate.branch, context.credentialOwnerId);
    if (remote.oid !== headOid || remote.treeOid !== treeOid) throw new Error('Provider integration ref does not match composed revision');
    const pull = await this.provider.ensureIntegrationPullRequest(context.repository, {
      headRef: current.candidate.branch,
      baseRef: current.candidate.baseBranch,
      expectedHeadOid: headOid,
      title: `Integration: ${current.candidate.integrationTaskId}`,
      body: `Managed Integration v3 candidate ${current.candidate.id}.`,
      operationKey: operationKey(current.candidate.id, current.candidate.currentRevision, 'pull'),
    }, context.credentialOwnerId);
    if (current.candidate.providerPullRequestId && current.candidate.providerPullRequestId !== pull.providerPullRequestId) {
      throw new Error('A different Integration PR is already bound to the candidate');
    }
    if (!current.candidate.providerPullRequestId) {
      await this.host.bindPullRequest(current.candidate.id, current.candidate.version, pull.providerPullRequestId);
      // Binding advances candidate CAS. The worker will reload and deterministically compose again.
      throw new IntegrationV3CandidateReloadRequiredError();
    }
    return {
      baseOid: sync.baseOid,
      headOid,
      treeOid,
      sources: ordered.map(stripSnapshotIdentity),
      ...(context.workExecutionId ? { workExecutionId: context.workExecutionId } : {}),
    };
  }

  async refreshAfterWork(current: Required<IntegrationV3WorkerCurrent>) {
    const context = await this.host.resolveContext(current);
    if (!current.candidate.providerPullRequestId || !this.provider.getReference) return undefined;
    const remote = await this.provider.getReference(context.repository, current.candidate.branch, context.credentialOwnerId);
    if (remote.oid === current.revision.headOid) return undefined;
    const base = await this.provider.getReference(context.repository, current.candidate.baseBranch, context.credentialOwnerId);
    return {
      baseOid: base.oid,
      headOid: remote.oid,
      treeOid: remote.treeOid,
      sources: [...context.sources].sort((a, b) => a.order - b.order).map(stripSnapshotIdentity),
      ...(context.workExecutionId ? { workExecutionId: context.workExecutionId } : {}),
    };
  }
}

export class IntegrationV3ComposeDisabledError extends Error { readonly retryable = false; }
export class IntegrationV3ComposeConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'IntegrationV3ComposeConflictError'; }
}
export class IntegrationV3CandidateReloadRequiredError extends Error { readonly retryable = true; constructor() { super('Candidate PR binding advanced; reload required'); } }

function stripSnapshotIdentity(source: TaskBoardIntegrationCandidateSourceSnapshot) {
  const { candidateId: _candidateId, revision: _revision, createdAt: _createdAt, ...input } = source;
  return input;
}
async function git(host: RepositoryWorkspaceSyncHost, cwd: string, args: readonly string[]) {
  const result = await host.runGit({ cwd, args });
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result;
}
function singleOid(result: { stdout: string }): string {
  const oid = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error(`Git returned invalid OID: ${oid}`);
  return oid;
}
function digestSources(sources: TaskBoardIntegrationCandidateSourceSnapshot[]): string {
  return createHash('sha256').update(sources.map((source) => `${source.order}:${source.frozenHeadOid}`).join('\n')).digest('hex');
}
function operationKey(candidateId: string, revision: number, kind: string): string {
  return `integration:v3:${kind}:${candidateId}:r${revision}`;
}
