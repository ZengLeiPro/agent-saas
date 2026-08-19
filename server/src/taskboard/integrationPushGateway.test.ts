import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { IntegrationPushCapabilityService, type IntegrationPushCapabilityBinding } from './integrationPushCapability.js';
import { InMemoryIntegrationPushCapabilityHost } from './integrationPushCapabilityMemoryHost.js';
import {
  IntegrationPushGateway,
  type IntegrationPushGitRunner,
} from './integrationPushGateway.js';
import {
  IntegrationProviderOperationService,
  type IntegrationProviderOperationRecord,
  type IntegrationProviderOperationState,
  type IntegrationProviderOperationStorageHost,
} from './integrationProviderOperations.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const TOKEN = 'github-secret-never-log';

const binding: IntegrationPushCapabilityBinding = {
  tenantId: 'tenant-1', repositoryId: 'github:org/repo', integrationTaskId: 'task-1',
  candidateId: 'candidate-1', revision: 2, executionId: 'execution-1',
  exactRef: 'refs/heads/integration/task-1', expectedOldOid: A, laneEpoch: 3, workflowEpoch: 4,
};

class MemoryOperations implements IntegrationProviderOperationStorageHost {
  records = new Map<string, IntegrationProviderOperationRecord>();
  async getByOperationKey(key: string) { return this.records.get(key); }
  async insertPrepared(record: IntegrationProviderOperationRecord) {
    const existing = this.records.get(record.operationKey); if (existing) return existing;
    this.records.set(record.operationKey, record); return record;
  }
  async compareAndSet(input: { id: string; expectedState: IntegrationProviderOperationState; nextState: IntegrationProviderOperationState; patch: any }) {
    const record = [...this.records.values()].find((item) => item.id === input.id);
    if (!record || record.state !== input.expectedState) return undefined;
    const updated = { ...record, ...input.patch, state: input.nextState };
    this.records.set(updated.operationKey, updated); return updated;
  }
}

class FakeGit implements IntegrationPushGitRunner {
  calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
  parentLine = `${B} ${A}`;
  remoteLine = `${A}\t${binding.exactRef}\n`;
  failPush = false;
  constructor(private readonly root: string) {}
  async run(input: { cwd: string; args: string[]; env?: Record<string, string> }): Promise<{ stdout: string }> {
    this.calls.push({ args: input.args, env: input.env });
    if (input.args[0] === '--version') return { stdout: 'git version 2.45.0' };
    if (input.args[0] === 'rev-parse') return { stdout: `${this.root}\n` };
    if (input.args[0] === 'cat-file') return { stdout: 'commit\n' };
    if (input.args[0] === 'rev-list') return { stdout: `${this.parentLine}\n` };
    if (input.args[0] === 'ls-remote') return { stdout: this.remoteLine };
    if (input.args[0] === 'push') {
      if (this.failPush) throw new Error(`provider echoed ${TOKEN}`);
      return { stdout: '' };
    }
    throw new Error(`unexpected git call ${input.args[0]}`);
  }
}

async function fixture() {
  const root = await mkdtemp(`${tmpdir()}/integration-push-test-`);
  const host = new InMemoryIntegrationPushCapabilityHost();
  const capabilityService = new IntegrationPushCapabilityService(host);
  const git = new FakeGit(root);
  const operationStorage = new MemoryOperations();
  const operationService = new IntegrationProviderOperationService(operationStorage, { assertCurrent: async () => undefined });
  let active = true;
  const gateway = new IntegrationPushGateway({
    enabled: true,
    allowedWorktreeRoots: [root],
    capabilityService,
    resolveTarget: async (input) => active && input.tenantId === binding.tenantId
      && input.executionId === binding.executionId && input.candidateId === binding.candidateId
      ? { binding, ownerUserId: 'owner-1' } : undefined,
    resolveRepository: async () => ({ worktreePath: root, remoteUrl: 'https://github.com/org/repo.git' }),
    resolveGithubToken: async () => ({ token: TOKEN, mode: 'restricted_pat', repositoryId: binding.repositoryId }),
    operationService,
    runner: git,
  });
  const issue = () => gateway.issue({
    tenantId: binding.tenantId, requesterUserId: 'owner-1',
    executionId: binding.executionId, candidateId: binding.candidateId,
  });
  const push = (capabilityToken: string, commitOid = B) => gateway.push({
    tenantId: binding.tenantId, requesterUserId: 'owner-1', executionId: binding.executionId,
    candidateId: binding.candidateId, capabilityToken, commitOid,
  });
  return { root, host, capabilityService, gateway, git, operationStorage, issue, push, disableTarget: () => { active = false; } };
}

describe('IntegrationPushGateway', () => {
  it('is disabled by default and reports the deployment health gate', async () => {
    const gateway = new IntegrationPushGateway({
      allowedWorktreeRoots: [], capabilityService: new IntegrationPushCapabilityService(new InMemoryIntegrationPushCapabilityHost()),
      resolveTarget: async () => undefined, resolveRepository: async () => undefined,
      resolveGithubToken: async () => undefined,
    });
    await expect(gateway.health()).resolves.toEqual({ enabled: false, healthy: false, reason: 'disabled' });
    await expect(gateway.issue({ tenantId: 't', requesterUserId: 'u', executionId: 'e', candidateId: 'c' }))
      .rejects.toMatchObject({ code: 'disabled', retryable: false });
  });

  it('pushes only the trusted exact ref with lease and keeps credential out of argv', async () => {
    const f = await fixture();
    try {
      const issued = await f.issue();
      await expect(f.push(issued.capabilityToken)).resolves.toEqual({ pushed: true, candidateId: binding.candidateId, commitOid: B });
      const push = f.git.calls.find((call) => call.args[0] === 'push')!;
      expect(push.args).toEqual([
        'push', `--force-with-lease=${binding.exactRef}:${A}`, '--',
        'https://github.com/org/repo.git', `${B}:${binding.exactRef}`,
      ]);
      expect(JSON.stringify(push.args)).not.toContain(TOKEN);
      await expect(f.capabilityService.verify(issued.capabilityToken)).rejects.toMatchObject({ code: 'already_consumed' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it.each([
    ['arbitrary target owner', async (f: Awaited<ReturnType<typeof fixture>>, token: string) => f.gateway.push({
      tenantId: binding.tenantId, requesterUserId: 'attacker', executionId: binding.executionId,
      candidateId: binding.candidateId, capabilityToken: token, commitOid: B,
    }), 'target_unavailable'],
    ['arbitrary candidate', async (f: Awaited<ReturnType<typeof fixture>>, token: string) => f.gateway.push({
      tenantId: binding.tenantId, requesterUserId: 'owner-1', executionId: binding.executionId,
      candidateId: 'other', capabilityToken: token, commitOid: B,
    }), 'target_mismatch'],
    ['tag syntax as oid', async (f: Awaited<ReturnType<typeof fixture>>, token: string) => f.push(token, 'HEAD:refs/tags/pwn'), 'invalid_commit'],
  ])('rejects attack: %s without consuming the capability', async (_name, attack, code) => {
    const f = await fixture();
    try {
      const issued = await f.issue();
      await expect(attack(f, issued.capabilityToken)).rejects.toMatchObject({ code });
      await expect(f.capabilityService.verify(issued.capabilityToken)).resolves.toMatchObject({ status: 'active' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('rejects merge commits and non-direct-parent history before credential lookup/consumption', async () => {
    const f = await fixture();
    try {
      const merge = await f.issue();
      f.git.parentLine = `${B} ${A} ${'c'.repeat(40)}`;
      await expect(f.push(merge.capabilityToken)).rejects.toMatchObject({ code: 'merge_commit_forbidden' });
      await expect(f.capabilityService.verify(merge.capabilityToken)).resolves.toMatchObject({ status: 'active' });
      f.git.parentLine = `${B} ${'d'.repeat(40)}`;
      await expect(f.push(merge.capabilityToken)).rejects.toMatchObject({ code: 'parent_mismatch' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('keeps pre-push lease mismatch retryable, but consumes on ambiguous push failure', async () => {
    const f = await fixture();
    try {
      const preflight = await f.issue();
      f.git.remoteLine = `${'c'.repeat(40)}\t${binding.exactRef}\n`;
      await expect(f.push(preflight.capabilityToken)).rejects.toMatchObject({ code: 'remote_old_mismatch', retryable: true });
      await expect(f.capabilityService.verify(preflight.capabilityToken)).resolves.toMatchObject({ status: 'active' });

      f.git.remoteLine = `${A}\t${binding.exactRef}\n`;
      f.git.failPush = true;
      await expect(f.push(preflight.capabilityToken)).rejects.toMatchObject({ code: 'push_failed_unknown', retryable: false });
      await expect(f.capabilityService.verify(preflight.capabilityToken)).rejects.toMatchObject({ code: 'already_consumed' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('durably records exact push intent and reconciles unknown by read-back without a second write', async () => {
    const f = await fixture();
    const input = {
      tenantId: binding.tenantId, ownerUserId: 'owner-1', repositoryId: binding.repositoryId,
      integrationTaskId: binding.integrationTaskId, candidateId: binding.candidateId,
      revision: binding.revision, exactRef: binding.exactRef, expectedOldOid: A, newOid: B,
      fence: { workflowEpoch: binding.workflowEpoch, laneEpoch: binding.laneEpoch,
        candidateId: binding.candidateId, candidateRevision: binding.revision, executionId: 'compose-1' },
    };
    try {
      f.git.failPush = true;
      await expect(f.gateway.pushExact(input)).rejects.toMatchObject({ code: 'push_failed_unknown' });
      expect([...f.operationStorage.records.values()][0]).toMatchObject({ kind: 'push_ref', state: 'unknown', expected: { oldOid: A, newOid: B } });
      f.git.failPush = false; f.git.remoteLine = `${B}\t${binding.exactRef}\n`;
      await expect(f.gateway.pushExact(input)).resolves.toBeUndefined();
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(1);
      expect([...f.operationStorage.records.values()][0]?.state).toBe('succeeded');
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('revokes immediately on cancel/fence and never leaks token material in errors', async () => {
    const f = await fixture();
    try {
      const issued = await f.issue();
      await f.gateway.cancel({ tenantId: binding.tenantId, executionId: binding.executionId,
        candidateId: binding.candidateId, reason: 'cancelled' });
      await expect(f.push(issued.capabilityToken)).rejects.not.toThrow(TOKEN);
      await expect(f.capabilityService.verify(issued.capabilityToken)).rejects.toMatchObject({ code: 'revoked' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
