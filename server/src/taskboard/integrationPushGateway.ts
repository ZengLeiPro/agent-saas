import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  IntegrationPushCapabilityService,
  type IntegrationPushCapabilityBinding,
} from './integrationPushCapability.js';
import type { AuthoritativeIntegrationPushTarget } from './integrationPushCapabilityPostgres.js';
import { runSafeServerGit } from './safeServerGitRunner.js';
import { withIntegrationGitAskpass } from './integrationGitAskpass.js';
import {
  IntegrationProviderOperationService,
  ProviderOperationReconcileRequiredError,
  integrationProviderOperationKey,
  type IntegrationProviderOperationFence,
  type IntegrationProviderOperationRecord,
} from './integrationProviderOperations.js';
import { withMaterializedWorkspaceCommit } from './workspaceCommitMaterializer.js';

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface IntegrationPushRepositoryAccess {
  worktreePath: string;
  /** Trusted canonical HTTPS clone URL. It must not contain userinfo or fragments. */
  remoteUrl: string;
  /** Board-configured identity resolved from the same authoritative row as the remote. */
  repositoryOwner: string;
  repositoryName: string;
}

export interface IntegrationPushGatewayOptions {
  /** Explicit production kill switch. Missing/false always fails closed. */
  enabled?: boolean;
  allowedWorktreeRoots: string[];
  capabilityService: IntegrationPushCapabilityService;
  resolveTarget(input: {
    tenantId: string;
    executionId: string;
    candidateId: string;
  }): Promise<AuthoritativeIntegrationPushTarget | undefined>;
  /** Resolves the current candidate solely from the active execution row. */
  resolveExecutionTarget?(input: {
    tenantId: string;
    executionId: string;
  }): Promise<AuthoritativeIntegrationPushTarget | undefined>;
  resolveRepository(input: {
    tenantId: string;
    repositoryId: string;
    ownerUserId: string;
    candidateId: string;
  }): Promise<IntegrationPushRepositoryAccess | undefined>;
  /** GitHub App installation token read. The token is never copied to runtime metadata. */
  resolveGithubToken(input: {
    tenantId: string;
    ownerUserId: string;
    repositoryId: string;
    repositoryOwner: string;
    repositoryName: string;
  }): Promise<IntegrationPushCredential | undefined>;
  githubAppInstallationId?: number;
  /** Required for every production write. Missing ledger keeps health fail-closed. */
  operationService?: IntegrationProviderOperationService;
  runner?: IntegrationPushGitRunner;
}

export interface IntegrationPushCredential {
  token: string;
  mode: 'github_app' | 'personal_access_token';
  /** Numeric repository identity returned by GitHub for the exact configured repository. */
  repositoryId: number;
  configuredRepositoryId: string;
  configuredRepositoryOwner: string;
  configuredRepositoryName: string;
  installationId?: number;
}

export interface IntegrationPushGitRunner {
  run(input: {
    cwd: string;
    args: string[];
    env?: Record<string, string>;
    redactOutput?: boolean;
  }): Promise<{ stdout: string }>;
}

export type IntegrationPushGatewayErrorCode =
  | 'disabled'
  | 'unhealthy'
  | 'target_unavailable'
  | 'target_mismatch'
  | 'invalid_commit'
  | 'worktree_unavailable'
  | 'remote_forbidden'
  | 'object_missing'
  | 'parent_mismatch'
  | 'merge_commit_forbidden'
  | 'remote_old_mismatch'
  | 'remote_read_failed'
  | 'credential_unavailable'
  | 'push_failed_unknown';

export class IntegrationPushGatewayError extends Error {
  constructor(public readonly code: IntegrationPushGatewayErrorCode, public readonly retryable: boolean) {
    super(`Integration push rejected: ${code}`);
    this.name = 'IntegrationPushGatewayError';
  }
}

/**
 * Narrow server-side path used by Integration Work/Review runtimes. Runtime input contains
 * only execution/candidate identity, the opaque capability, and a local commit OID.
 * Ref, old OID, remote and worktree are always resolved from trusted server state.
 */
export class IntegrationPushGateway {
  private readonly runner: IntegrationPushGitRunner;

  constructor(private readonly options: IntegrationPushGatewayOptions) {
    this.runner = options.runner ?? new ExecFileIntegrationPushGitRunner();
  }

  async health(): Promise<{ enabled: boolean; healthy: boolean; reason?: string }> {
    if (this.options.enabled !== true) return { enabled: false, healthy: false, reason: 'disabled' };
    if (!this.options.operationService) return { enabled: true, healthy: false, reason: 'durable_operation_ledger_unavailable' };
    if (this.options.allowedWorktreeRoots.length === 0) {
      return { enabled: true, healthy: false, reason: 'no_allowed_worktree_roots' };
    }
    try {
      for (const root of this.options.allowedWorktreeRoots) {
        if (!isAbsolute(root) || !(await stat(await realpath(root))).isDirectory()) {
          return { enabled: true, healthy: false, reason: 'invalid_allowed_worktree_root' };
        }
      }
      await this.runner.run({ cwd: this.options.allowedWorktreeRoots[0]!, args: ['--version'] });
      return { enabled: true, healthy: true };
    } catch {
      return { enabled: true, healthy: false, reason: 'git_or_worktree_unavailable' };
    }
  }

  async issue(input: {
    tenantId: string;
    requesterUserId: string;
    executionId: string;
    candidateId: string;
    ttlMs?: number;
  }): Promise<{ capabilityToken: string; expiresAt: string }> {
    await this.assertHealthy();
    const target = await this.options.resolveTarget(input);
    if (!target || target.ownerUserId !== input.requesterUserId) {
      throw new IntegrationPushGatewayError('target_unavailable', false);
    }
    await this.options.capabilityService.fence({
      tenantId: target.binding.tenantId,
      repositoryId: target.binding.repositoryId,
      integrationTaskId: target.binding.integrationTaskId,
      candidateId: target.binding.candidateId,
      revision: target.binding.revision,
      laneEpoch: target.binding.laneEpoch,
      workflowEpoch: target.binding.workflowEpoch,
      enabled: true,
    }, 'active integration execution');
    const issued = await this.options.capabilityService.issue({
      binding: target.binding,
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    });
    return { capabilityToken: issued.token, expiresAt: issued.expiresAt };
  }

  async push(input: {
    tenantId: string;
    requesterUserId: string;
    executionId: string;
    candidateId: string;
    capabilityToken: string;
    commitOid: string;
  }): Promise<{ pushed: true; candidateId: string; commitOid: string }> {
    await this.assertHealthy();
    const target = await this.authorizeRuntimePush(input);
    const repository = await this.resolvePushRepository(target);
    const cwd = await this.resolveControlledWorktree(repository.worktreePath);
    await this.pushAuthorized({ ...input, target, repository, cwd, durable: false });
    return { pushed: true, candidateId: input.candidateId, commitOid: input.commitOid };
  }

  /** Server-only Work Agent path. The opaque capability never crosses this call boundary. */
  async pushWorkspaceCommit(input: {
    tenantId: string;
    requesterUserId: string;
    executionId: string;
    workspaceRoot: string;
    commitOid: string;
  }): Promise<{ pushed: true; candidateId: string; commitOid: string }> {
    await this.assertHealthy();
    if (!this.options.resolveExecutionTarget) throw new IntegrationPushGatewayError('target_unavailable', false);
    const target = await this.options.resolveExecutionTarget({
      tenantId: input.tenantId,
      executionId: input.executionId,
    });
    if (!target || target.ownerUserId !== input.requesterUserId) {
      throw new IntegrationPushGatewayError('target_unavailable', false);
    }
    await this.options.capabilityService.fence({
      tenantId: target.binding.tenantId, repositoryId: target.binding.repositoryId,
      integrationTaskId: target.binding.integrationTaskId, candidateId: target.binding.candidateId,
      revision: target.binding.revision, laneEpoch: target.binding.laneEpoch,
      workflowEpoch: target.binding.workflowEpoch, enabled: true,
    }, 'active integration work execution');
    const sourceRepository = await this.resolvePushRepository(target);
    return withMaterializedWorkspaceCommit({
      workspaceRoot: input.workspaceRoot,
      repositoryName: sourceRepository.repositoryName,
      commitOid: input.commitOid,
      expectedOldOid: target.binding.expectedOldOid,
      expectedBaseOid: target.binding.expectedBaseOid,
    }, async ({ repositoryPath }) => {
      // Issue only after source objects are self-contained and verified, then push immediately.
      const issued = await this.options.capabilityService.issue({ binding: target.binding });
      let pushed = false;
      try {
        const runtimeInput = {
          tenantId: input.tenantId, requesterUserId: input.requesterUserId,
          executionId: input.executionId, candidateId: target.binding.candidateId,
          capabilityToken: issued.token, commitOid: input.commitOid,
        };
        const authorized = await this.authorizeRuntimePush(runtimeInput);
        const repository = await this.resolvePushRepository(authorized);
        await this.pushAuthorized({
          ...runtimeInput, target: authorized, repository, cwd: repositoryPath, durable: true,
        });
        pushed = true;
        return { pushed: true as const, candidateId: target.binding.candidateId, commitOid: input.commitOid };
      } finally {
        // Consumed ambiguous writes remain consumed and revoke() treats that as idempotent.
        await this.options.capabilityService.revoke(
          issued.capabilityId,
          pushed ? 'integration work push completed' : 'integration work push failed before capability consumption',
        );
      }
    });
  }

  private async authorizeRuntimePush(input: {
    tenantId: string; requesterUserId: string; executionId: string; candidateId: string;
    capabilityToken: string; commitOid: string;
  }): Promise<AuthoritativeIntegrationPushTarget> {
    if (!OID.test(input.commitOid)) throw new IntegrationPushGatewayError('invalid_commit', true);
    const capability = await this.options.capabilityService.verify(input.capabilityToken);
    assertRuntimeTarget(capability.binding, input);
    const target = await this.options.resolveTarget(input);
    if (!target || target.ownerUserId !== input.requesterUserId || !sameBinding(target.binding, capability.binding)) {
      throw new IntegrationPushGatewayError('target_unavailable', false);
    }
    return target;
  }

  private async resolvePushRepository(target: AuthoritativeIntegrationPushTarget): Promise<IntegrationPushRepositoryAccess> {
    const repository = await this.options.resolveRepository({
      tenantId: target.binding.tenantId, repositoryId: target.binding.repositoryId,
      ownerUserId: target.ownerUserId, candidateId: target.binding.candidateId,
    });
    if (!repository) throw new IntegrationPushGatewayError('worktree_unavailable', true);
    validateRemote(repository.remoteUrl);
    return repository;
  }

  private async pushAuthorized(input: {
    tenantId: string; requesterUserId: string; executionId: string; candidateId: string;
    capabilityToken: string; commitOid: string; target: AuthoritativeIntegrationPushTarget;
    repository: IntegrationPushRepositoryAccess; cwd: string; durable: boolean;
  }): Promise<void> {
    const { target, repository, cwd } = input;
    const graph = await this.assertCommitGraph(
      cwd, target.binding.expectedOldOid, input.commitOid, target.binding.expectedBaseOid, true,
    );
    const credential = await this.options.resolveGithubToken({
      tenantId: target.binding.tenantId, ownerUserId: target.ownerUserId,
      repositoryId: target.binding.repositoryId, repositoryOwner: repository.repositoryOwner,
      repositoryName: repository.repositoryName,
    });
    if (!credential || !credentialMatchesRepository(credential, {
      repositoryId: target.binding.repositoryId, repositoryOwner: repository.repositoryOwner,
      repositoryName: repository.repositoryName,
    }, this.options.githubAppInstallationId)) throw new IntegrationPushGatewayError('credential_unavailable', false);
    const operationKey = integrationProviderOperationKey({
      repositoryId: target.binding.repositoryId, candidateId: target.binding.candidateId,
      candidateRevision: target.binding.revision, kind: 'push_ref',
      target: `work:${target.binding.executionId}:${target.binding.exactRef}@${input.commitOid}`,
    });
    const operation = input.durable ? await this.options.operationService!.prepare({
      operationKey, kind: 'push_ref', repositoryId: target.binding.repositoryId,
      fence: {
        workflowEpoch: target.binding.workflowEpoch, laneEpoch: target.binding.laneEpoch,
        candidateId: target.binding.candidateId, candidateRevision: target.binding.revision,
        executionId: target.binding.executionId,
      },
      // Keep the durable intent backward-compatible with pre-rebase Work operations.
      // The commit OID binds the immutable graph; parent/mode are added only to the success receipt.
      expected: { ref: target.binding.exactRef, oldOid: target.binding.expectedOldOid, newOid: input.commitOid },
      command: { ref: target.binding.exactRef, oldOid: target.binding.expectedOldOid, newOid: input.commitOid },
    }) : undefined;
    await withIntegrationGitAskpass(credential.token, async (env) => {
      if (operation && operation.state !== 'prepared') {
        await this.reconcileOrVerifyPriorPush(operation, {
          repositoryId: target.binding.repositoryId, candidateId: target.binding.candidateId,
          revision: target.binding.revision, exactRef: target.binding.exactRef, newOid: input.commitOid,
          fence: operation.fence,
        }, cwd, repository.remoteUrl, env);
        return;
      }
      const remoteOld = await this.readExactRemoteRef(cwd, repository.remoteUrl, target.binding.exactRef, env);
      if (remoteOld !== target.binding.expectedOldOid) throw new IntegrationPushGatewayError('remote_old_mismatch', true);
      await this.options.capabilityService.consume(input.capabilityToken, {
        ref: target.binding.exactRef, oldOid: target.binding.expectedOldOid, newOid: input.commitOid,
        parentOid: graph.parentOid, isFastForward: graph.isFastForward, operation: 'update',
        laneEpoch: target.binding.laneEpoch, workflowEpoch: target.binding.workflowEpoch,
      });
      const write = async () => {
        await this.runner.run({
          cwd, args: ['push', `--force-with-lease=${target.binding.exactRef}:${target.binding.expectedOldOid}`,
            '--', repository.remoteUrl, `${input.commitOid}:${target.binding.exactRef}`],
          env, redactOutput: true,
        });
        return {
          ref: target.binding.exactRef, oldOid: target.binding.expectedOldOid, newOid: input.commitOid,
          parentOid: graph.parentOid, pushMode: graph.isFastForward ? 'fast_forward' : 'rebase',
        };
      };
      if (operation) {
        let completed: IntegrationProviderOperationRecord;
        try {
          completed = await this.options.operationService!.execute(operationKey, write);
        } catch (error) {
          if (!(error instanceof ProviderOperationReconcileRequiredError)) throw error;
          const raced = await this.options.operationService!.get(operationKey);
          if (!raced) throw new IntegrationPushGatewayError('push_failed_unknown', false);
          await this.reconcileOrVerifyPriorPush(raced, {
            repositoryId: target.binding.repositoryId, candidateId: target.binding.candidateId,
            revision: target.binding.revision, exactRef: target.binding.exactRef, newOid: input.commitOid,
            fence: operation.fence,
          }, cwd, repository.remoteUrl, env);
          return;
        }
        if (completed.state !== 'succeeded') throw new IntegrationPushGatewayError('push_failed_unknown', false);
      } else await write().catch(() => { throw new IntegrationPushGatewayError('push_failed_unknown', false); });
    });
  }

  /** Trusted compose boundary. Every write is first persisted as an exact semantic
   * intent. An executing/unknown intent is never pushed again and can only perform
   * authenticated ls-remote read-back reconciliation. */
  async pushExact(input: {
    tenantId: string; ownerUserId: string; repositoryId: string; integrationTaskId: string;
    candidateId: string; revision: number; exactRef: string; expectedOldOid: string; newOid: string;
    /** Server compose may re-parent a deterministic candidate when the authoritative base advanced. */
    rebaseParentOid?: string;
    fence: IntegrationProviderOperationFence;
  }): Promise<void> {
    await this.assertHealthy();
    if (!OID.test(input.expectedOldOid) || !OID.test(input.newOid)) throw new IntegrationPushGatewayError('invalid_commit', false);
    const repository = await this.options.resolveRepository({
      tenantId: input.tenantId, repositoryId: input.repositoryId, ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
    });
    if (!repository) throw new IntegrationPushGatewayError('worktree_unavailable', true);
    validateRemote(repository.remoteUrl);
    const cwd = await this.resolveControlledWorktree(repository.worktreePath);
    const credential = await this.options.resolveGithubToken({
      tenantId: input.tenantId, ownerUserId: input.ownerUserId, repositoryId: input.repositoryId,
      repositoryOwner: repository.repositoryOwner, repositoryName: repository.repositoryName,
    });
    if (!credential || !credentialMatchesRepository(credential, {
      repositoryId: input.repositoryId,
      repositoryOwner: repository.repositoryOwner,
      repositoryName: repository.repositoryName,
    }, this.options.githubAppInstallationId)) {
      throw new IntegrationPushGatewayError('credential_unavailable', false);
    }
    // The composed OID is part of the semantic key. A candidate revision can be reloaded
    // after PR binding, but a different deterministic head must never collide with (or
    // silently reuse) the ledger row for the first head.
    const operationKey = integrationProviderOperationKey({
      repositoryId: input.repositoryId, candidateId: input.candidateId,
      candidateRevision: input.revision, kind: 'push_ref', target: `${input.exactRef}@${input.newOid}`,
    });
    const service = this.options.operationService!;
    const prior = await service.get(operationKey);
    if (prior && prior.state !== 'prepared') {
      await withIntegrationGitAskpass(credential.token, async (env) => {
        await this.reconcileOrVerifyPriorPush(prior, input, cwd, repository.remoteUrl, env);
      });
      return;
    }
    // Equality is only legal on a post-bind/restart replay with a matching durable
    // operation above. Never manufacture a no-op intent with a rewritten old OID.
    if (input.expectedOldOid === input.newOid) throw new IntegrationPushGatewayError('remote_old_mismatch', false);
    await this.assertCommitGraph(cwd, input.expectedOldOid, input.newOid, input.rebaseParentOid);
    const operation = await service.prepare({
      operationKey, kind: 'push_ref', repositoryId: input.repositoryId, fence: input.fence,
      expected: { ref: input.exactRef, oldOid: input.expectedOldOid, newOid: input.newOid },
      command: { ref: input.exactRef, oldOid: input.expectedOldOid, newOid: input.newOid },
    });
    await withIntegrationGitAskpass(credential.token, async (env) => {
      if (operation.state !== 'prepared') {
        await this.reconcileOrVerifyPriorPush(operation, input, cwd, repository.remoteUrl, env);
        return;
      }
      const remoteOld = await this.readExactRemoteRef(cwd, repository.remoteUrl, input.exactRef, env);
      if (remoteOld !== input.expectedOldOid) throw new IntegrationPushGatewayError('remote_old_mismatch', true);
      let completed: IntegrationProviderOperationRecord;
      try {
        completed = await service.execute(operationKey, async () => {
          await this.runExactPush(cwd, repository.remoteUrl, input.exactRef, input.expectedOldOid, input.newOid, env);
          return { ref: input.exactRef, oldOid: input.expectedOldOid, newOid: input.newOid };
        });
      } catch (error) {
        if (!(error instanceof ProviderOperationReconcileRequiredError)) throw error;
        const raced = await service.get(operationKey);
        if (!raced) throw new IntegrationPushGatewayError('push_failed_unknown', false);
        await this.reconcileOrVerifyPriorPush(raced, input, cwd, repository.remoteUrl, env);
        return;
      }
      if (completed.state === 'executing') throw new IntegrationPushGatewayError('push_failed_unknown', true);
      if (completed.state === 'unknown') {
        completed = await service.reconcile(operationKey, (record) => this.reconcileExactRef(record, cwd, repository.remoteUrl, env));
      }
      if (completed.state === 'succeeded') return;
      if (this.isVerifiedNotApplied(completed, input.exactRef, input.expectedOldOid, input.newOid)) {
        await this.executeVerifiedOldRetry(completed, input, cwd, repository.remoteUrl, env);
        return;
      }
      throw new IntegrationPushGatewayError('push_failed_unknown', false);
    });
  }

  async cancel(input: {
    tenantId: string;
    executionId: string;
    candidateId: string;
    reason: string;
  }): Promise<void> {
    const target = await this.options.resolveTarget(input);
    if (!target) return;
    await this.options.capabilityService.fence({
      tenantId: target.binding.tenantId,
      repositoryId: target.binding.repositoryId,
      integrationTaskId: target.binding.integrationTaskId,
      candidateId: target.binding.candidateId,
      revision: target.binding.revision,
      laneEpoch: target.binding.laneEpoch,
      workflowEpoch: target.binding.workflowEpoch,
      enabled: false,
    }, input.reason || 'integration execution cancelled');
  }

  private async reconcileOrVerifyPriorPush(
    operation: IntegrationProviderOperationRecord,
    input: {
      repositoryId: string; candidateId: string; revision: number; exactRef: string; newOid: string;
      rebaseParentOid?: string; fence: IntegrationProviderOperationFence;
    },
    cwd: string,
    remoteUrl: string,
    env: Record<string, string>,
  ): Promise<void> {
    const expectedRef = String(operation.expected.ref ?? '');
    const expectedOld = String(operation.expected.oldOid ?? '');
    const expectedNew = String(operation.expected.newOid ?? '');
    const fence = operation.fence;
    if (operation.kind !== 'push_ref' || operation.repositoryId !== input.repositoryId
      || expectedRef !== input.exactRef || expectedNew !== input.newOid || !OID.test(expectedOld)
      || fence.candidateId !== input.candidateId || fence.candidateRevision !== input.revision
      || fence.workflowEpoch !== input.fence.workflowEpoch || fence.laneEpoch !== input.fence.laneEpoch) {
      throw new IntegrationPushGatewayError('push_failed_unknown', false);
    }
    let durable = operation;
    if (durable.state === 'executing') throw new IntegrationPushGatewayError('push_failed_unknown', true);
    if (durable.state === 'unknown') {
      durable = await this.options.operationService!.reconcile(
        durable.operationKey,
        (record) => this.reconcileExactRef(record, cwd, remoteUrl, env),
      );
    }
    if (durable.state === 'succeeded'
      && String(durable.receipt?.ref ?? '') === input.exactRef
      && String(durable.receipt?.newOid ?? '') === input.newOid) {
      const actual = await this.readExactRemoteRef(cwd, remoteUrl, input.exactRef, env);
      if (actual !== input.newOid) throw new IntegrationPushGatewayError('remote_old_mismatch', false);
      return;
    }
    if (this.isVerifiedNotApplied(durable, input.exactRef, expectedOld, input.newOid)) {
      await this.assertCommitGraph(cwd, expectedOld, input.newOid, input.rebaseParentOid);
      await this.executeVerifiedOldRetry(durable, input, cwd, remoteUrl, env);
      return;
    }
    throw new IntegrationPushGatewayError('push_failed_unknown', false);
  }

  private async executeVerifiedOldRetry(
    original: IntegrationProviderOperationRecord,
    input: {
      repositoryId: string; candidateId: string; revision: number; exactRef: string; newOid: string;
      fence: IntegrationProviderOperationFence;
    },
    cwd: string,
    remoteUrl: string,
    env: Record<string, string>,
  ): Promise<void> {
    const oldOid = String(original.expected.oldOid ?? '');
    const operationKey = integrationProviderOperationKey({
      repositoryId: input.repositoryId, candidateId: input.candidateId,
      candidateRevision: input.revision, kind: 'push_ref',
      target: `${input.exactRef}@${input.newOid}:verified-old-retry:${original.operationKey}`,
    });
    const service = this.options.operationService!;
    const operation = await service.prepare({
      operationKey, kind: 'push_ref', repositoryId: input.repositoryId, fence: input.fence,
      expected: { ref: input.exactRef, oldOid, newOid: input.newOid, recoveryOf: original.operationKey },
      command: { ref: input.exactRef, oldOid, newOid: input.newOid, recoveryOf: original.operationKey },
    });
    let durable = operation;
    if (durable.state === 'executing') throw new IntegrationPushGatewayError('push_failed_unknown', true);
    if (durable.state === 'unknown') {
      durable = await service.reconcile(operationKey, (record) => this.reconcileExactRef(record, cwd, remoteUrl, env));
    }
    if (durable.state === 'succeeded') {
      const actual = await this.readExactRemoteRef(cwd, remoteUrl, input.exactRef, env);
      if (actual !== input.newOid) throw new IntegrationPushGatewayError('remote_old_mismatch', false);
      return;
    }
    if (durable.state !== 'prepared') throw new IntegrationPushGatewayError('push_failed_unknown', false);
    const remoteOld = await this.readExactRemoteRef(cwd, remoteUrl, input.exactRef, env);
    if (remoteOld !== oldOid) throw new IntegrationPushGatewayError('remote_old_mismatch', false);
    try {
      durable = await service.execute(operationKey, async () => {
        await this.runExactPush(cwd, remoteUrl, input.exactRef, oldOid, input.newOid, env);
        return { ref: input.exactRef, oldOid, newOid: input.newOid,
          recoveryOf: original.operationKey, recoveredAfterVerifiedOld: true };
      });
    } catch (error) {
      if (!(error instanceof ProviderOperationReconcileRequiredError)) throw error;
      durable = await service.get(operationKey) ?? operation;
    }
    if (durable.state === 'executing') throw new IntegrationPushGatewayError('push_failed_unknown', true);
    if (durable.state === 'unknown') {
      durable = await service.reconcile(operationKey, (record) => this.reconcileExactRef(record, cwd, remoteUrl, env));
    }
    if (durable.state !== 'succeeded') throw new IntegrationPushGatewayError('push_failed_unknown', false);
    const actual = await this.readExactRemoteRef(cwd, remoteUrl, input.exactRef, env);
    if (actual !== input.newOid) throw new IntegrationPushGatewayError('remote_old_mismatch', false);
  }

  private isVerifiedNotApplied(
    operation: IntegrationProviderOperationRecord,
    ref: string,
    oldOid: string,
    newOid: string,
  ): boolean {
    const receipt = operation.receipt;
    if (operation.attemptCount !== 1 || receipt?.ref !== ref || receipt.actualOid !== oldOid) return false;
    if (operation.state === 'failed' && receipt.verifiedNotApplied === true) {
      return receipt.expectedOldOid === oldOid && receipt.expectedNewOid === newOid;
    }
    // Before verified-old recovery existed, the same authoritative read-back was
    // misclassified as needs_human/mismatch. Accept only that exact legacy receipt.
    return operation.state === 'needs_human'
      && operation.error === 'Exact remote ref points to an unexpected OID'
      && receipt.expectedNew === newOid;
  }

  private async runExactPush(
    cwd: string,
    remoteUrl: string,
    exactRef: string,
    oldOid: string,
    newOid: string,
    env: Record<string, string>,
  ): Promise<void> {
    await this.runner.run({
      cwd, args: ['push', `--force-with-lease=${exactRef}:${oldOid}`, '--', remoteUrl, `${newOid}:${exactRef}`],
      env, redactOutput: true,
    });
  }

  private async readExactRemoteRef(cwd: string, remoteUrl: string, exactRef: string, env: Record<string, string>): Promise<string | undefined> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await this.runner.run({ cwd, args: ['ls-remote', '--refs', remoteUrl, exactRef], env, redactOutput: true });
        if (!result.stdout.trim()) return undefined;
        const fields = result.stdout.trim().split(/\s+/);
        if (fields.length !== 2 || fields[1] !== exactRef || !OID.test(fields[0]!)) throw new Error('invalid remote ref response');
        return fields[0];
      } catch {
        if (attempt === 3) throw new IntegrationPushGatewayError('remote_read_failed', true);
        await delay(attempt * 200);
      }
    }
    throw new IntegrationPushGatewayError('remote_read_failed', true);
  }

  private async reconcileExactRef(
    operation: IntegrationProviderOperationRecord,
    cwd: string,
    remoteUrl: string,
    env: Record<string, string>,
  ) {
    const ref = String(operation.expected.ref ?? '');
    const expectedOld = String(operation.expected.oldOid ?? '');
    const expectedNew = String(operation.expected.newOid ?? '');
    const actual = await this.readExactRemoteRef(cwd, remoteUrl, ref, env);
    if (actual === expectedNew) return { status: 'succeeded' as const, receipt: { ref, newOid: actual, reconciled: true } };
    if (actual === expectedOld) {
      return {
        status: 'not_applied' as const,
        detail: 'Exact remote ref remains at the expected old OID',
        evidence: { ref, actualOid: actual, expectedOldOid: expectedOld, expectedNewOid: expectedNew, verifiedNotApplied: true },
      };
    }
    if (!actual) return { status: 'not_found' as const, detail: 'Exact remote ref is not visible' };
    return { status: 'mismatch' as const, detail: 'Exact remote ref points to an unexpected OID', evidence: { ref, actualOid: actual, expectedNew } };
  }

  private async assertHealthy(): Promise<void> {
    if (this.options.enabled !== true) throw new IntegrationPushGatewayError('disabled', false);
    const health = await this.health();
    if (!health.healthy) throw new IntegrationPushGatewayError('unhealthy', false);
  }

  private async resolveControlledWorktree(candidate: string): Promise<string> {
    try {
      const actual = await realpath(resolve(candidate));
      const allowed = await Promise.all(this.options.allowedWorktreeRoots.map((root) => realpath(root)));
      if (!allowed.some((root) => isWithin(root, actual))) throw new Error('outside root');
      const top = (await this.runner.run({ cwd: actual, args: ['rev-parse', '--show-toplevel'] })).stdout.trim();
      if (await realpath(top) !== actual) throw new Error('not exact worktree');
      return actual;
    } catch {
      throw new IntegrationPushGatewayError('worktree_unavailable', true);
    }
  }

  private async assertCommitGraph(
    cwd: string,
    oldOid: string,
    newOid: string,
    rebaseParentOid?: string,
    requireDivergedRebase = false,
  ): Promise<{ parentOid: string; isFastForward: boolean }> {
    try {
      const oldType = (await this.runner.run({ cwd, args: ['cat-file', '-t', oldOid] })).stdout.trim();
      const newType = (await this.runner.run({ cwd, args: ['cat-file', '-t', newOid] })).stdout.trim();
      const baseType = rebaseParentOid
        ? (await this.runner.run({ cwd, args: ['cat-file', '-t', rebaseParentOid] })).stdout.trim()
        : 'commit';
      if (oldType !== 'commit' || newType !== 'commit' || baseType !== 'commit') throw new Error('not commit');
    } catch {
      throw new IntegrationPushGatewayError('object_missing', true);
    }
    const parents = (await this.runner.run({ cwd, args: ['rev-list', '--parents', '-n', '1', newOid] })
      .catch(() => { throw new IntegrationPushGatewayError('object_missing', true); })).stdout.trim().split(/\s+/);
    if (parents.length > 2) throw new IntegrationPushGatewayError('merge_commit_forbidden', true);
    if (parents.length !== 2) throw new IntegrationPushGatewayError('parent_mismatch', true);
    const parentOid = parents[1]!;
    if (parentOid === oldOid) return { parentOid, isFastForward: true };
    if (!rebaseParentOid || parentOid !== rebaseParentOid || rebaseParentOid === oldOid) {
      throw new IntegrationPushGatewayError('parent_mismatch', true);
    }
    if (requireDivergedRebase) {
      const mergeBase = await this.runner.run({ cwd, args: ['merge-base', rebaseParentOid, oldOid] })
        .catch(() => { throw new IntegrationPushGatewayError('object_missing', true); });
      if (!OID.test(mergeBase.stdout.trim()) || mergeBase.stdout.trim() === rebaseParentOid) {
        throw new IntegrationPushGatewayError('parent_mismatch', true);
      }
    }
    return { parentOid, isFastForward: false };
  }

}

export class ExecFileIntegrationPushGitRunner implements IntegrationPushGitRunner {
  async run(input: {
    cwd: string;
    args: string[];
    env?: Record<string, string>;
    redactOutput?: boolean;
  }): Promise<{ stdout: string }> {
    const result = await runSafeServerGit({ cwd: input.cwd, args: input.args, ...(input.env ? { env: input.env } : {}) });
    if (result.exitCode !== 0) {
      // Never surface child stderr/stdout: providers and helpers may echo credentials or URLs.
      throw new Error(input.redactOutput ? 'git command failed (redacted)' : 'git command failed');
    }
    return { stdout: result.stdout };
  }
}

function assertRuntimeTarget(
  binding: IntegrationPushCapabilityBinding,
  input: { tenantId: string; executionId: string; candidateId: string },
): void {
  if (binding.tenantId !== input.tenantId || binding.executionId !== input.executionId
    || binding.candidateId !== input.candidateId) {
    throw new IntegrationPushGatewayError('target_mismatch', false);
  }
}

function sameBinding(a: IntegrationPushCapabilityBinding, b: IntegrationPushCapabilityBinding): boolean {
  return a.tenantId === b.tenantId && a.repositoryId === b.repositoryId
    && a.integrationTaskId === b.integrationTaskId && a.candidateId === b.candidateId
    && a.revision === b.revision && a.executionId === b.executionId && a.exactRef === b.exactRef
    && a.expectedOldOid === b.expectedOldOid && a.expectedBaseOid === b.expectedBaseOid
    && a.laneEpoch === b.laneEpoch && a.workflowEpoch === b.workflowEpoch;
}

export function credentialMatchesRepository(
  credential: IntegrationPushCredential,
  configured: { repositoryId: string; repositoryOwner: string; repositoryName: string },
  configuredInstallationId: number | undefined,
): boolean {
  const match = /^github-id:(\d+)$/.exec(configured.repositoryId);
  if (credential.token.length === 0
    || credential.configuredRepositoryId !== configured.repositoryId
    || credential.configuredRepositoryOwner.toLowerCase() !== configured.repositoryOwner.toLowerCase()
    || credential.configuredRepositoryName.toLowerCase() !== configured.repositoryName.toLowerCase()) return false;
  if (match && Number(match[1]) !== credential.repositoryId) return false;
  return credential.mode === 'personal_access_token'
    || (credential.mode === 'github_app' && Number.isSafeInteger(configuredInstallationId)
      && configuredInstallationId === credential.installationId);
}

function validateRemote(value: string): void {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search || parsed.port
      || parsed.hostname.toLowerCase() !== 'github.com'
      || !/^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/.test(parsed.pathname)
      || /%2f|%5c/i.test(parsed.pathname)) throw new Error('forbidden');
  } catch {
    throw new IntegrationPushGatewayError('remote_forbidden', false);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
