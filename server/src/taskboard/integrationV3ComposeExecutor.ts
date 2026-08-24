import { createHash } from 'node:crypto';

import type { TaskBoardIntegrationCandidateSourceSnapshot, TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import { computeIntegrationSourceSetDigest } from './integrationCandidateDigest.js';
import type { AppendCandidateRevisionInput } from './integrationCandidateStore.js';
import {
  GithubApiError,
  canonicalGithubRepositoryUrl,
  type RepositoryBranchReceipt,
  type RepositoryIntegrationPullRequestReceipt,
  type RepositoryProvider,
} from './repositoryProvider.js';
import {
  IntegrationProviderOperationService,
  ProviderOperationReconcileRequiredError,
  integrationProviderOperationKey,
  type IntegrationProviderOperationRecord,
} from './integrationProviderOperations.js';
import { syncRepositoryWorkspaceLocked, withRepositoryScopeLock, type RepositoryWorkspaceSyncHost } from './repositoryWorkspaceSync.js';
import type { IntegrationV3CandidateLease, IntegrationV3ComposeExecutor, IntegrationV3LeaseGuard, IntegrationV3WorkerCurrent } from './integrationV3Worker.js';

export interface IntegrationV3WorkPushReceipt {
  executionId: string;
  candidateId: string;
  candidateRevision: number;
  workflowEpoch: string;
  laneEpoch: string;
  ref: string;
  oldOid: string;
  newOid: string;
}

export interface IntegrationV3ComposeContext {
  repository: TaskBoardRepositoryConfig;
  credentialOwnerId: string;
  tenantId: string;
  repositoryPath: string;
  worktreePath: string;
  sources: TaskBoardIntegrationCandidateSourceSnapshot[];
  trustedIntegrationBranchOids?: string[];
  workExecutionId?: string;
  workPushReceipt?: IntegrationV3WorkPushReceipt;
}

export interface IntegrationV3ComposeHost extends RepositoryWorkspaceSyncHost {
  resolveContext(current: Required<IntegrationV3WorkerCurrent>): Promise<IntegrationV3ComposeContext>;
  withRepositoryFetchCredential?<T>(
    context: IntegrationV3ComposeContext,
    action: (env: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T>;
  /** Exact server-owned push. Must CAS the trusted integration ref; undefined means disabled fail-closed. */
  pushIntegrationHead?(input: {
    context: IntegrationV3ComposeContext;
    branch: string;
    expectedOldOid: string;
    headOid: string;
    headParentOid: string;
    candidateId: string;
    revision: number;
    integrationTaskId: string;
    laneEpoch: number;
    workflowEpoch: number;
    mutationFence: IntegrationV3CandidateLease;
    assertCurrent(): Promise<void>;
  }): Promise<void>;
  bindPullRequest(
    candidateId: string,
    expectedVersion: number,
    providerPullRequestId: string,
    lease: IntegrationV3CandidateLease,
  ): Promise<void>;
}

/** Deterministic local compose: origin/<base>, frozen heads in source_order, one stable commit. */
export class DefaultIntegrationV3ComposeExecutor implements IntegrationV3ComposeExecutor {
  constructor(
    private readonly host: IntegrationV3ComposeHost,
    private readonly provider: RepositoryProvider,
    private readonly providerOperations: IntegrationProviderOperationService,
  ) {}

  async compose(current: Required<IntegrationV3WorkerCurrent>, guard: IntegrationV3LeaseGuard) {
    const context = await this.host.resolveContext(current);
    if (!this.host.pushIntegrationHead) throw new IntegrationV3ComposeDisabledError('Exact integration push service is not registered');
    if (!this.provider.ensureIntegrationBranch || !this.provider.ensureIntegrationPullRequest || !this.provider.getReference) {
      throw new IntegrationV3ComposeDisabledError('Repository provider does not support durable integration branch/PR composition');
    }
    const ordered = [...context.sources].sort((a, b) => a.order - b.order);
    if (computeIntegrationSourceSetDigest(ordered.map(stripSnapshotIdentity)) !== current.revision.sourceSetDigest) {
      throw new IntegrationV3InvalidWorkResultError('Compose context does not match the complete frozen source set');
    }
    const syncInput = {
      repositoryPath: context.repositoryPath,
      worktreePath: context.worktreePath,
      baseBranch: current.candidate.baseBranch,
      integrationBranch: current.candidate.branch,
      controlledRemoteUrl: canonicalGithubRepositoryUrl(context.repository),
      integrationWorktreeMode: 'reset_to_base' as const,
      frozenPullRequestHeads: context.sources.map((source) => ({
        providerPullRequestId: source.providerPullRequestId,
        expectedHeadOid: source.frozenHeadOid,
      })),
    };
    const composeLocked = async (fetchEnvironment?: Readonly<Record<string, string>>) => withRepositoryScopeLock(
      this.host,
      context.repositoryPath,
      async () => {
        await guard.assertCurrent();
        const sync = await syncRepositoryWorkspaceLocked(
          this.host,
          { ...syncInput, ...(fetchEnvironment ? { fetchEnvironment } : {}) },
          guard.assertCurrent,
        );
        await guardedGit(this.host, guard, context.worktreePath, ['reset', '--hard', sync.baseOid]);
        const baseTreeOid = singleOid(await guardedGit(this.host, guard, context.worktreePath, ['rev-parse', `${sync.baseOid}^{tree}`]));
        let treeOid = baseTreeOid;
        for (const source of ordered) {
          try {
            await guardedGit(this.host, guard, context.worktreePath, ['cherry-pick', '--no-commit', `${source.frozenBaseOid}..${source.frozenHeadOid}`]);
            treeOid = singleOid(await guardedGit(this.host, guard, context.worktreePath, ['write-tree']));
          } catch (error) {
            await guard.assertCurrent();
            await this.host.runGit({ cwd: context.worktreePath, args: ['cherry-pick', '--abort'] }).catch(() => undefined);
            await guardedGit(this.host, guard, context.worktreePath, ['reset', '--hard', sync.baseOid]);
            const evidence = `Frozen source ${source.integrationSourceId} conflicts at ${source.frozenHeadOid}: ${error instanceof Error ? error.message : String(error)}`;
            const revision = await this.createSubject({
              current, context, ordered, baseOid: sync.baseOid, treeOid,
              compositionComplete: false, conflictSourceId: source.integrationSourceId, guard,
            });
            throw new IntegrationV3ComposeConflictError(evidence, revision);
          }
        }
        return this.createSubject({
          current, context, ordered, baseOid: sync.baseOid, treeOid,
          compositionComplete: true, guard,
        });
      },
    );
    return this.host.withRepositoryFetchCredential
      ? this.host.withRepositoryFetchCredential(context, composeLocked)
      : composeLocked();
  }

  /** Reconcile only the persisted subject. This path never invokes local Compose. */
  async publish(current: Required<IntegrationV3WorkerCurrent>, guard: IntegrationV3LeaseGuard): Promise<void> {
    const context = await this.host.resolveContext(current);
    if (!this.host.pushIntegrationHead || !this.provider.ensureIntegrationBranch
      || !this.provider.ensureIntegrationPullRequest || !this.provider.getReference
      || current.revision.subjectKind !== 'provider_subject' || !current.revision.treeOid) {
      throw new IntegrationV3ComposeDisabledError('Durable Integration subject publication is unavailable');
    }
    const ordered = [...context.sources].sort((a, b) => a.order - b.order);
    if (computeIntegrationSourceSetDigest(ordered.map(stripSnapshotIdentity)) !== current.revision.sourceSetDigest) {
      throw new IntegrationV3InvalidWorkResultError('Persisted subject source set is unavailable or changed');
    }
    const revision = current.revision.revision;
    await guard.assertCurrent();
    const base = await this.provider.getReference(context.repository, current.candidate.baseBranch, context.credentialOwnerId);
    if (base.oid !== current.revision.baseOid || !base.treeOid) {
      throw new IntegrationV3InvalidWorkResultError('Persisted subject base no longer matches the authoritative base');
    }
    await guard.assertCurrent();
    const branchReceipt = await this.ensureBranchDurably(current, context, guard, {
      ref: current.candidate.branch,
      expectedBaseOid: current.revision.baseOid,
      expectedBaseTreeOid: base.treeOid,
      trustedExistingOids: context.trustedIntegrationBranchOids,
      existingRequired: Boolean(current.candidate.providerPullRequestId),
    });
    await guard.assertCurrent();
    await this.host.pushIntegrationHead({
      context,
      branch: current.candidate.branch,
      expectedOldOid: branchReceipt.oid,
      headOid: current.revision.headOid,
      headParentOid: current.revision.baseOid,
      candidateId: current.candidate.id,
      revision,
      integrationTaskId: current.candidate.integrationTaskId,
      laneEpoch: Number(current.candidate.laneEpoch),
      workflowEpoch: Number(current.candidate.workflowEpoch),
      mutationFence: guard.lease,
      assertCurrent: guard.assertCurrent,
    });
    await guard.assertCurrent();
    const remote = await this.provider.getReference(context.repository, current.candidate.branch, context.credentialOwnerId);
    if (remote.oid !== current.revision.headOid || remote.treeOid !== current.revision.treeOid) {
      throw new IntegrationV3InvalidWorkResultError('Provider integration ref does not match the persisted revision');
    }
    await guard.assertCurrent();
    const pull = await this.ensurePullRequestDurably(current, context, guard, {
      headRef: current.candidate.branch,
      baseRef: current.candidate.baseBranch,
      expectedHeadOid: current.revision.headOid,
      title: `Integration: ${current.candidate.integrationTaskId}`,
      body: `Managed Integration v3 candidate ${current.candidate.id}.`,
    });
    if (current.candidate.providerPullRequestId && current.candidate.providerPullRequestId !== pull.providerPullRequestId) {
      throw new IntegrationV3InvalidWorkResultError('A different Integration PR is already bound to the persisted subject');
    }
    if (!current.candidate.providerPullRequestId) {
      await guard.assertCurrent();
      await this.host.bindPullRequest(
        current.candidate.id,
        current.candidate.version,
        pull.providerPullRequestId,
        guard.lease,
      );
      throw new IntegrationV3CandidateReloadRequiredError();
    }
  }

  private async ensureBranchDurably(
    current: Required<IntegrationV3WorkerCurrent>,
    context: IntegrationV3ComposeContext,
    guard: IntegrationV3LeaseGuard,
    input: {
      ref: string;
      expectedBaseOid: string;
      expectedBaseTreeOid: string;
      trustedExistingOids?: string[];
      existingRequired: boolean;
    },
  ): Promise<RepositoryBranchReceipt> {
    for (let retry = 0; retry <= 1; retry += 1) {
      const operationKey = integrationProviderOperationKey({
        repositoryId: current.candidate.repositoryId,
        candidateId: current.candidate.id,
        candidateRevision: current.revision.revision,
        kind: 'create_branch',
        target: `${input.ref}:${input.expectedBaseOid}:attempt-${retry}`,
      });
      let operation = await this.providerOperations.prepare({
        operationKey,
        kind: 'create_branch',
        repositoryId: current.candidate.repositoryId,
        fence: providerFence(current, `compose-branch:${retry}`),
        expected: {
          ref: input.ref,
          expectedBaseOid: input.expectedBaseOid,
          expectedBaseTreeOid: input.expectedBaseTreeOid,
        },
        command: { ref: input.ref, expectedBaseOid: input.expectedBaseOid },
      });
      if (operation.state === 'succeeded') return branchReceipt(operation);
      if (operation.state === 'prepared') {
        operation = await this.providerOperations.execute(operationKey, async () => ({
          ...await this.provider.ensureIntegrationBranch!(context.repository, {
            ...input,
            operationKey,
          }, context.credentialOwnerId),
        }), {
          assertAttemptCurrent: guard.assertCurrent,
          mutationFence: guard.lease,
        });
        if (operation.state === 'succeeded') return branchReceipt(operation);
        // The owner that made an ambiguous remote call never retries or reconciles it.
        throw new ProviderOperationReconcileRequiredError(operationKey, operation.state);
      }
      if (operation.state === 'executing' || operation.state === 'unknown') {
        const observedState = operation.state;
        operation = await this.providerOperations.reconcile(operationKey, async () => {
          try {
            const reference = await this.provider.getReference!(context.repository, input.ref, context.credentialOwnerId);
            if (reference.oid === input.expectedBaseOid && reference.treeOid === input.expectedBaseTreeOid) {
              return { status: 'succeeded', receipt: { operationKey, ...reference, created: false, reconciled: true } } as const;
            }
            return {
              status: 'mismatch',
              detail: 'Integration branch exists with a different durable subject',
              evidence: { ref: reference.ref, oid: reference.oid, treeOid: reference.treeOid },
            } as const;
          } catch (error) {
            if (error instanceof GithubApiError && error.status === 404) {
              return observedState === 'unknown'
                ? {
                    status: 'not_applied',
                    detail: 'Integration branch was absent after the completed ambiguous provider attempt',
                    evidence: {
                      verifiedNotApplied: true,
                      evidence: 'github_ref_404_after_ambiguous_attempt',
                      ref: input.ref,
                    },
                  } as const
                : { status: 'not_found', detail: 'Integration branch is not yet observable' } as const;
            }
            throw error;
          }
        }, { assertAttemptCurrent: guard.assertCurrent, mutationFence: guard.lease });
        if (operation.state === 'succeeded') return branchReceipt(operation);
        if (operation.state === 'failed' && isVerifiedNotApplied(operation, 'github_ref_404_after_ambiguous_attempt')) continue;
        throw new ProviderOperationReconcileRequiredError(operationKey, operation.state);
      }
      if (operation.state === 'failed' && isVerifiedNotApplied(operation, 'github_ref_404_after_ambiguous_attempt')) continue;
      throw new IntegrationV3InvalidWorkResultError(operation.error ?? 'Integration branch provider operation is terminal');
    }
    throw new IntegrationV3InvalidWorkResultError('Integration branch retry budget was exhausted');
  }

  private async ensurePullRequestDurably(
    current: Required<IntegrationV3WorkerCurrent>,
    context: IntegrationV3ComposeContext,
    guard: IntegrationV3LeaseGuard,
    input: { headRef: string; baseRef: string; expectedHeadOid: string; title: string; body: string },
  ): Promise<RepositoryIntegrationPullRequestReceipt> {
    for (let retry = 0; retry <= 1; retry += 1) {
      const operationKey = integrationProviderOperationKey({
        repositoryId: current.candidate.repositoryId,
        candidateId: current.candidate.id,
        candidateRevision: current.revision.revision,
        kind: 'create_pull_request',
        target: `${input.headRef}:${input.baseRef}:${input.expectedHeadOid}:attempt-${retry}`,
      });
      let operation = await this.providerOperations.prepare({
        operationKey,
        kind: 'create_pull_request',
        repositoryId: current.candidate.repositoryId,
        fence: providerFence(current, `compose-pull-request:${retry}`),
        expected: { headRef: input.headRef, baseRef: input.baseRef, expectedHeadOid: input.expectedHeadOid },
        command: { ...input },
      });
      if (operation.state === 'succeeded') return pullRequestReceipt(operation);
      if (operation.state === 'prepared') {
        operation = await this.providerOperations.execute(operationKey, async () => ({
          ...await this.provider.ensureIntegrationPullRequest!(context.repository, {
            ...input,
            operationKey,
          }, context.credentialOwnerId),
        }), {
          assertAttemptCurrent: guard.assertCurrent,
          mutationFence: guard.lease,
        });
        if (operation.state === 'succeeded') return pullRequestReceipt(operation);
        throw new ProviderOperationReconcileRequiredError(operationKey, operation.state);
      }
      if (operation.state === 'executing' || operation.state === 'unknown') {
        if (!this.provider.findIntegrationPullRequest) {
          throw new IntegrationV3ComposeDisabledError('Repository provider cannot reconcile Integration PR creation');
        }
        const observedState = operation.state;
        operation = await this.providerOperations.reconcile(operationKey, async () => {
          const pull = await this.provider.findIntegrationPullRequest!(context.repository, input, context.credentialOwnerId);
          if (pull) return { status: 'succeeded', receipt: { ...pull, operationKey, reconciled: true } } as const;
          return observedState === 'unknown'
            ? {
                status: 'not_applied',
                detail: 'Integration PR search was empty after the completed ambiguous provider attempt',
                evidence: {
                  verifiedNotApplied: true,
                  evidence: 'github_pr_search_empty_after_ambiguous_attempt',
                  headRef: input.headRef,
                  baseRef: input.baseRef,
                  expectedHeadOid: input.expectedHeadOid,
                },
              } as const
            : { status: 'not_found', detail: 'Integration PR is not yet observable' } as const;
        }, { assertAttemptCurrent: guard.assertCurrent, mutationFence: guard.lease });
        if (operation.state === 'succeeded') return pullRequestReceipt(operation);
        if (operation.state === 'failed' && isVerifiedNotApplied(operation, 'github_pr_search_empty_after_ambiguous_attempt')) continue;
        throw new ProviderOperationReconcileRequiredError(operationKey, operation.state);
      }
      if (operation.state === 'failed' && isVerifiedNotApplied(operation, 'github_pr_search_empty_after_ambiguous_attempt')) continue;
      throw new IntegrationV3InvalidWorkResultError(operation.error ?? 'Integration pull request provider operation is terminal');
    }
    throw new IntegrationV3InvalidWorkResultError('Integration pull request retry budget was exhausted');
  }

  private async createSubject(input: {
    current: Required<IntegrationV3WorkerCurrent>;
    context: IntegrationV3ComposeContext;
    ordered: TaskBoardIntegrationCandidateSourceSnapshot[];
    baseOid: string;
    treeOid: string;
    compositionComplete: boolean;
    conflictSourceId?: string;
    guard: IntegrationV3LeaseGuard;
  }) {
    const { current, context, ordered, baseOid, treeOid, compositionComplete, guard } = input;
    const nextRevision = current.candidate.currentRevision + 1;
    const timestamp = new Date(current.candidate.createdAt).toISOString();
    const conflictLine = input.conflictSourceId ? `Conflict-Source: ${input.conflictSourceId}\n` : '';
    const message = `Integration candidate ${current.candidate.id} revision ${nextRevision}\n\nSource-Set: ${digestSources(ordered)}\nComposition-Complete: ${compositionComplete}\n${conflictLine}`;
    await guard.assertCurrent();
    const commit = await this.host.runGit({
      cwd: context.worktreePath,
      args: ['commit-tree', treeOid, '-p', baseOid, '-m', message],
      env: {
        GIT_AUTHOR_NAME: 'Integration Worker', GIT_AUTHOR_EMAIL: 'integration-worker@localhost',
        GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_NAME: 'Integration Worker',
        GIT_COMMITTER_EMAIL: 'integration-worker@localhost', GIT_COMMITTER_DATE: timestamp,
      },
    });
    if (commit.exitCode !== 0) throw new Error(commit.stderr || 'git commit-tree failed');
    const headOid = singleOid(commit);
    await guardedGit(this.host, guard, context.worktreePath, ['reset', '--hard', headOid]);
    return {
      baseOid, headOid, treeOid, compositionComplete,
      sources: ordered.map(stripSnapshotIdentity),
      ...(context.workExecutionId ? { workExecutionId: context.workExecutionId } : {}),
    };
  }

  async refreshAfterWork(current: Required<IntegrationV3WorkerCurrent>) {
    const context = await this.host.resolveContext(current);
    // A remote ref can move for reasons unrelated to the bound remediation run. Only a
    // current work execution with a fenced in_review transition may advance
    // the candidate subject; later Run completion cannot override that explicit decision.
    if (!context.workExecutionId) return undefined;
    const ordered = [...context.sources].sort((a, b) => a.order - b.order);
    if (computeIntegrationSourceSetDigest(ordered.map(stripSnapshotIdentity)) !== current.revision.sourceSetDigest) {
      throw new IntegrationV3InvalidWorkResultError('Work context does not match the complete frozen source set');
    }
    if (!current.candidate.providerPullRequestId || !this.provider.getReference) {
      throw new IntegrationV3InvalidWorkResultError('Ready work result cannot resolve the integration and base refs');
    }
    const [remote, base] = await Promise.all([
      this.provider.getReference(context.repository, current.candidate.branch, context.credentialOwnerId),
      this.provider.getReference(context.repository, current.candidate.baseBranch, context.credentialOwnerId),
    ]);
    if (remote.oid === current.revision.headOid) {
      if (!current.revision.treeOid) {
        throw new IntegrationV3InvalidWorkResultError('Current candidate revision has no trusted tree OID');
      }
      if (!current.revision.compositionComplete) {
        throw new IntegrationV3InvalidWorkResultError('Incomplete composition requires an exact succeeded work push');
      }
      if (base.oid === current.revision.baseOid) {
        throw new IntegrationV3InvalidWorkResultError('Ready work result changed neither the integration head nor the base');
      }
      return {
        baseOid: base.oid,
        headOid: current.revision.headOid,
        treeOid: current.revision.treeOid,
        compositionComplete: true,
        sources: ordered.map(stripSnapshotIdentity),
        workExecutionId: context.workExecutionId,
      };
    }
    if (!remote.treeOid) {
      throw new IntegrationV3InvalidWorkResultError('Changed integration head has no trusted tree OID');
    }
    const receipt = context.workPushReceipt;
    if (!receipt
      || receipt.executionId !== context.workExecutionId
      || receipt.candidateId !== current.candidate.id
      || receipt.candidateRevision !== current.candidate.currentRevision
      || receipt.workflowEpoch !== current.candidate.workflowEpoch
      || receipt.laneEpoch !== current.candidate.laneEpoch
      || receipt.ref !== `refs/heads/${current.candidate.branch}`
      || receipt.oldOid !== current.revision.headOid
      || receipt.newOid !== remote.oid) {
      throw new IntegrationV3InvalidWorkResultError('Changed integration head has no matching succeeded push receipt');
    }
    if (!current.revision.compositionComplete && remote.treeOid === current.revision.treeOid) {
      throw new IntegrationV3InvalidWorkResultError('Incomplete composition work push did not change the candidate tree');
    }
    return {
      baseOid: base.oid,
      headOid: remote.oid,
      treeOid: remote.treeOid,
      compositionComplete: true,
      sources: ordered.map(stripSnapshotIdentity),
      workExecutionId: context.workExecutionId,
    };
  }
}

export class IntegrationV3ComposeDisabledError extends Error { readonly retryable = false; }
export class IntegrationV3InvalidWorkResultError extends Error {
  constructor(message: string) { super(message); this.name = 'IntegrationV3InvalidWorkResultError'; }
}
export class IntegrationV3ComposeConflictError extends Error {
  constructor(
    message: string,
    readonly revision: Omit<AppendCandidateRevisionInput, 'expectedVersion' | 'expectedCurrentRevision' | 'nextState'>,
  ) {
    super(message);
    this.name = 'IntegrationV3ComposeConflictError';
  }
}
export class IntegrationV3CandidateReloadRequiredError extends Error { readonly retryable = true; constructor() { super('Candidate PR binding advanced; reload required'); } }

function stripSnapshotIdentity(source: TaskBoardIntegrationCandidateSourceSnapshot) {
  const { candidateId: _candidateId, revision: _revision, createdAt: _createdAt, ...input } = source;
  return input;
}
async function guardedGit(
  host: RepositoryWorkspaceSyncHost,
  guard: IntegrationV3LeaseGuard,
  cwd: string,
  args: readonly string[],
) {
  await guard.assertCurrent();
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
function providerFence(current: Required<IntegrationV3WorkerCurrent>, executionSuffix: string) {
  return {
    workflowEpoch: Number(current.candidate.workflowEpoch),
    laneEpoch: Number(current.candidate.laneEpoch),
    candidateId: current.candidate.id,
    candidateRevision: current.revision.revision,
    executionId: `integration-v3-compose:${current.candidate.id}:r${current.revision.revision}:${executionSuffix}`,
  };
}

function branchReceipt(operation: IntegrationProviderOperationRecord): RepositoryBranchReceipt {
  const receipt = operation.receipt ?? {};
  const ref = typeof receipt.ref === 'string' ? receipt.ref : operation.expected.ref;
  const treeOid = typeof receipt.treeOid === 'string' ? receipt.treeOid : operation.expected.expectedBaseTreeOid;
  if (typeof ref !== 'string' || typeof receipt.oid !== 'string' || typeof treeOid !== 'string') {
    throw new IntegrationV3InvalidWorkResultError('Durable Integration branch receipt is incomplete');
  }
  return {
    operationKey: operation.operationKey,
    ref,
    oid: receipt.oid,
    treeOid,
    created: receipt.created === true,
    raw: record(receipt.raw),
  };
}

function pullRequestReceipt(operation: IntegrationProviderOperationRecord): RepositoryIntegrationPullRequestReceipt {
  const receipt = operation.receipt ?? {};
  const providerPullRequestId = typeof receipt.providerPullRequestId === 'string' ? receipt.providerPullRequestId : '';
  const number = Number(receipt.number ?? providerPullRequestId);
  const headRef = typeof receipt.headRef === 'string' ? receipt.headRef : operation.expected.headRef;
  const headOid = typeof receipt.headOid === 'string' ? receipt.headOid : operation.expected.expectedHeadOid;
  const baseRef = typeof receipt.baseRef === 'string' ? receipt.baseRef : operation.expected.baseRef;
  if (!Number.isInteger(number) || number < 1 || !providerPullRequestId
    || typeof headRef !== 'string' || typeof headOid !== 'string' || typeof baseRef !== 'string') {
    throw new IntegrationV3InvalidWorkResultError('Durable Integration pull request receipt is incomplete');
  }
  return {
    operationKey: operation.operationKey,
    providerPullRequestId,
    number,
    headRef,
    headOid,
    baseRef,
    created: receipt.created === true,
    raw: record(receipt.raw),
  };
}

function isVerifiedNotApplied(operation: IntegrationProviderOperationRecord, evidence: string): boolean {
  return operation.receipt?.outcome === 'not_applied'
    && operation.receipt.verifiedNotApplied === true
    && operation.receipt.evidence === evidence;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
