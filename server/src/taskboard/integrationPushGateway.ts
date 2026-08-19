import { access, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  IntegrationPushCapabilityService,
  type IntegrationPushCapabilityBinding,
} from './integrationPushCapability.js';
import type { AuthoritativeIntegrationPushTarget } from './integrationPushCapabilityPostgres.js';
import { runSafeServerGit, safeServerGitEnvironment } from './safeServerGitRunner.js';
import {
  IntegrationProviderOperationService,
  integrationProviderOperationKey,
  type IntegrationProviderOperationFence,
  type IntegrationProviderOperationRecord,
} from './integrationProviderOperations.js';

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface IntegrationPushRepositoryAccess {
  worktreePath: string;
  /** Trusted canonical HTTPS clone URL. It must not contain userinfo or fragments. */
  remoteUrl: string;
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
  }): Promise<IntegrationPushCredential | undefined>;
  githubAppInstallationId?: number;
  /** Required for every production write. Missing ledger keeps health fail-closed. */
  operationService?: IntegrationProviderOperationService;
  runner?: IntegrationPushGitRunner;
}

export interface IntegrationPushCredential {
  token: string;
  mode: 'github_app';
  /** Immutable numeric identities returned by the trusted App provider. */
  repositoryId: number;
  installationId: number;
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
    if (!OID.test(input.commitOid)) throw new IntegrationPushGatewayError('invalid_commit', true);
    const capability = await this.options.capabilityService.verify(input.capabilityToken);
    assertRuntimeTarget(capability.binding, input);
    const target = await this.options.resolveTarget(input);
    if (!target || target.ownerUserId !== input.requesterUserId
      || !sameBinding(target.binding, capability.binding)) {
      throw new IntegrationPushGatewayError('target_unavailable', false);
    }
    const repository = await this.options.resolveRepository({
      tenantId: target.binding.tenantId,
      repositoryId: target.binding.repositoryId,
      ownerUserId: target.ownerUserId,
      candidateId: target.binding.candidateId,
    });
    if (!repository) throw new IntegrationPushGatewayError('worktree_unavailable', true);
    const cwd = await this.resolveControlledWorktree(repository.worktreePath);
    validateRemote(repository.remoteUrl);

    await this.assertCommitGraph(cwd, target.binding.expectedOldOid, input.commitOid);
    const token = await this.options.resolveGithubToken({
      tenantId: target.binding.tenantId,
      ownerUserId: target.ownerUserId,
      repositoryId: target.binding.repositoryId,
    });
    if (!token || !credentialMatchesRepository(token, target.binding.repositoryId, this.options.githubAppInstallationId)) {
      throw new IntegrationPushGatewayError('credential_unavailable', false);
    }

    await this.withAskpass(token.token, async (env) => {
      const remoteOld = await this.runner.run({
        cwd,
        args: ['ls-remote', '--refs', repository.remoteUrl, target.binding.exactRef],
        env,
        redactOutput: true,
      }).catch(() => { throw new IntegrationPushGatewayError('remote_old_mismatch', true); });
      const fields = remoteOld.stdout.trim().split(/\s+/);
      if (fields.length !== 2 || fields[0] !== target.binding.expectedOldOid || fields[1] !== target.binding.exactRef) {
        throw new IntegrationPushGatewayError('remote_old_mismatch', true);
      }
      // Consume only after every deterministic/pre-push check. From this point any failure is
      // ambiguous and the bearer is intentionally not reusable; issue a fresh capability only
      // after reconciling the exact remote ref.
      await this.options.capabilityService.consume(input.capabilityToken, {
        ref: target.binding.exactRef,
        oldOid: target.binding.expectedOldOid,
        newOid: input.commitOid,
        isFastForward: true,
        operation: 'update',
        laneEpoch: target.binding.laneEpoch,
        workflowEpoch: target.binding.workflowEpoch,
      });
      await this.runner.run({
        cwd,
        args: [
          'push',
          `--force-with-lease=${target.binding.exactRef}:${target.binding.expectedOldOid}`,
          '--',
          repository.remoteUrl,
          `${input.commitOid}:${target.binding.exactRef}`,
        ],
        env,
        redactOutput: true,
      }).catch(() => { throw new IntegrationPushGatewayError('push_failed_unknown', false); });
    });
    return { pushed: true, candidateId: input.candidateId, commitOid: input.commitOid };
  }

  /** Trusted compose boundary. Every write is first persisted as an exact semantic
   * intent. An executing/unknown intent is never pushed again and can only perform
   * authenticated ls-remote read-back reconciliation. */
  async pushExact(input: {
    tenantId: string; ownerUserId: string; repositoryId: string; integrationTaskId: string;
    candidateId: string; revision: number; exactRef: string; expectedOldOid: string; newOid: string;
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
    });
    if (!credential || !credentialMatchesRepository(credential, input.repositoryId, this.options.githubAppInstallationId)) {
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
      await this.withAskpass(credential.token, async (env) => {
        await this.reconcileOrVerifyPriorPush(prior, input, cwd, repository.remoteUrl, env);
      });
      return;
    }
    // Equality is only legal on a post-bind/restart replay with a matching durable
    // operation above. Never manufacture a no-op intent with a rewritten old OID.
    if (input.expectedOldOid === input.newOid) throw new IntegrationPushGatewayError('remote_old_mismatch', false);
    await this.assertCommitGraph(cwd, input.expectedOldOid, input.newOid);
    const operation = await service.prepare({
      operationKey, kind: 'push_ref', repositoryId: input.repositoryId, fence: input.fence,
      expected: { ref: input.exactRef, oldOid: input.expectedOldOid, newOid: input.newOid },
      command: { ref: input.exactRef, oldOid: input.expectedOldOid, newOid: input.newOid },
    });
    await this.withAskpass(credential.token, async (env) => {
      if (operation.state === 'unknown' || operation.state === 'executing') {
        const reconciled = await service.reconcile(operationKey, (record) => this.reconcileExactRef(record, cwd, repository.remoteUrl, env));
        if (reconciled.state !== 'succeeded') throw new IntegrationPushGatewayError('push_failed_unknown', false);
        return;
      }
      const remoteOld = await this.readExactRemoteRef(cwd, repository.remoteUrl, input.exactRef, env);
      if (remoteOld !== input.expectedOldOid) throw new IntegrationPushGatewayError('remote_old_mismatch', true);
      const completed = await service.execute(operationKey, async () => {
        await this.runner.run({
          cwd, args: ['push', `--force-with-lease=${input.exactRef}:${input.expectedOldOid}`, '--',
            repository.remoteUrl, `${input.newOid}:${input.exactRef}`], env, redactOutput: true,
        });
        return { ref: input.exactRef, oldOid: input.expectedOldOid, newOid: input.newOid };
      });
      if (completed.state !== 'succeeded') throw new IntegrationPushGatewayError('push_failed_unknown', false);
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
      fence: IntegrationProviderOperationFence;
    },
    cwd: string,
    remoteUrl: string,
    env: Record<string, string>,
  ): Promise<void> {
    const expectedRef = String(operation.expected.ref ?? '');
    const expectedNew = String(operation.expected.newOid ?? '');
    const fence = operation.fence;
    if (operation.kind !== 'push_ref' || operation.repositoryId !== input.repositoryId
      || expectedRef !== input.exactRef || expectedNew !== input.newOid
      || fence.candidateId !== input.candidateId || fence.candidateRevision !== input.revision
      || fence.workflowEpoch !== input.fence.workflowEpoch || fence.laneEpoch !== input.fence.laneEpoch) {
      throw new IntegrationPushGatewayError('push_failed_unknown', false);
    }
    let durable = operation;
    if (durable.state === 'unknown' || durable.state === 'executing') {
      durable = await this.options.operationService!.reconcile(
        durable.operationKey,
        (record) => this.reconcileExactRef(record, cwd, remoteUrl, env),
      );
    }
    if (durable.state !== 'succeeded'
      || String(durable.receipt?.ref ?? '') !== input.exactRef
      || String(durable.receipt?.newOid ?? '') !== input.newOid) {
      throw new IntegrationPushGatewayError('push_failed_unknown', false);
    }
    const actual = await this.readExactRemoteRef(cwd, remoteUrl, input.exactRef, env);
    if (actual !== input.newOid) throw new IntegrationPushGatewayError('remote_old_mismatch', false);
  }

  private async readExactRemoteRef(cwd: string, remoteUrl: string, exactRef: string, env: Record<string, string>): Promise<string | undefined> {
    const result = await this.runner.run({ cwd, args: ['ls-remote', '--refs', remoteUrl, exactRef], env, redactOutput: true });
    if (!result.stdout.trim()) return undefined;
    const fields = result.stdout.trim().split(/\s+/);
    if (fields.length !== 2 || fields[1] !== exactRef || !OID.test(fields[0]!)) throw new Error('invalid remote ref response');
    return fields[0];
  }

  private async reconcileExactRef(
    operation: IntegrationProviderOperationRecord,
    cwd: string,
    remoteUrl: string,
    env: Record<string, string>,
  ) {
    const ref = String(operation.expected.ref ?? '');
    const expectedNew = String(operation.expected.newOid ?? '');
    const actual = await this.readExactRemoteRef(cwd, remoteUrl, ref, env);
    if (actual === expectedNew) return { status: 'succeeded' as const, receipt: { ref, newOid: actual, reconciled: true } };
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

  private async assertCommitGraph(cwd: string, oldOid: string, newOid: string): Promise<void> {
    try {
      const oldType = (await this.runner.run({ cwd, args: ['cat-file', '-t', oldOid] })).stdout.trim();
      const newType = (await this.runner.run({ cwd, args: ['cat-file', '-t', newOid] })).stdout.trim();
      if (oldType !== 'commit' || newType !== 'commit') throw new Error('not commit');
    } catch {
      throw new IntegrationPushGatewayError('object_missing', true);
    }
    const parents = (await this.runner.run({ cwd, args: ['rev-list', '--parents', '-n', '1', newOid] })
      .catch(() => { throw new IntegrationPushGatewayError('object_missing', true); })).stdout.trim().split(/\s+/);
    if (parents.length > 2) throw new IntegrationPushGatewayError('merge_commit_forbidden', true);
    if (parents.length !== 2 || parents[1] !== oldOid) {
      throw new IntegrationPushGatewayError('parent_mismatch', true);
    }
  }

  private async withAskpass<T>(token: string, action: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(`${tmpdir()}/ky-integration-push-`);
    const askpass = resolve(dir, 'askpass.sh');
    try {
      await writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "x-access-token";; *) printf "%s\\n" "$KY_GIT_PUSH_TOKEN";; esac\n', { mode: 0o700 });
      await access(askpass);
      return await action(safeServerGitEnvironment({
        HOME: dir,
        XDG_CONFIG_HOME: dir,
        GIT_ASKPASS: askpass,
        KY_GIT_PUSH_TOKEN: token,
      }) as Record<string, string>);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    && a.expectedOldOid === b.expectedOldOid && a.laneEpoch === b.laneEpoch
    && a.workflowEpoch === b.workflowEpoch;
}

function credentialMatchesRepository(
  credential: IntegrationPushCredential,
  configuredRepositoryId: string,
  configuredInstallationId: number | undefined,
): boolean {
  const match = /^github-id:(\d+)$/.exec(configuredRepositoryId);
  return credential.mode === 'github_app'
    && credential.token.length > 0
    && !!match
    && Number(match[1]) === credential.repositoryId
    && Number.isSafeInteger(configuredInstallationId)
    && configuredInstallationId === credential.installationId;
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
