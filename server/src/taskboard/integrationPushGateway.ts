import { execFile } from 'node:child_process';
import { access, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  IntegrationPushCapabilityService,
  type IntegrationPushCapabilityBinding,
} from './integrationPushCapability.js';
import type { AuthoritativeIntegrationPushTarget } from './integrationPushCapabilityPostgres.js';

const execFileAsync = promisify(execFile);
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
  }): Promise<IntegrationPushRepositoryAccess | undefined>;
  /** Server-side connector read. The returned token is never copied to runtime metadata. */
  resolveGithubToken(input: {
    tenantId: string;
    ownerUserId: string;
    repositoryId: string;
  }): Promise<string | undefined>;
  runner?: IntegrationPushGitRunner;
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
    if (!token) throw new IntegrationPushGatewayError('credential_unavailable', true);

    await this.withAskpass(token, async (env) => {
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
      return await action({
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'C',
        HOME: dir,
        GIT_ASKPASS: askpass,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        KY_GIT_PUSH_TOKEN: token,
      });
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
    try {
      const result = await execFileAsync('git', input.args, {
        cwd: input.cwd,
        env: input.env,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return { stdout: result.stdout };
    } catch {
      // Never surface child stderr/stdout: providers and helpers may echo credentials or URLs.
      throw new Error(input.redactOutput ? 'git command failed (redacted)' : 'git command failed');
    }
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

function validateRemote(value: string): void {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash
      || !['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase())) throw new Error('forbidden');
  } catch {
    throw new IntegrationPushGatewayError('remote_forbidden', false);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
