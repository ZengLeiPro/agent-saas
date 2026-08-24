import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { IntegrationPushCapabilityService, type IntegrationPushCapabilityBinding } from './integrationPushCapability.js';
import { InMemoryIntegrationPushCapabilityHost } from './integrationPushCapabilityMemoryHost.js';
import {
  IntegrationPushGateway,
  type IntegrationPushCredential,
  type IntegrationPushGitRunner,
} from './integrationPushGateway.js';
import {
  IntegrationProviderOperationService,
  integrationProviderOperationKey,
  type IntegrationProviderOperationRecord,
  type IntegrationProviderOperationState,
  type IntegrationProviderOperationStorageHost,
} from './integrationProviderOperations.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const TOKEN = 'github-secret-never-log';

const binding: IntegrationPushCapabilityBinding = {
  tenantId: 'tenant-1', repositoryId: 'github-id:123', integrationTaskId: 'task-1',
  candidateId: 'candidate-1', revision: 2, executionId: 'execution-1',
  exactRef: 'refs/heads/integration/task-1', expectedOldOid: A, expectedBaseOid: C,
  laneEpoch: 3, workflowEpoch: 4,
};

class MemoryOperations implements IntegrationProviderOperationStorageHost {
  records = new Map<string, IntegrationProviderOperationRecord>();
  beforeInsert?: (record: IntegrationProviderOperationRecord) => void;
  async getByOperationKey(key: string) { return this.records.get(key); }
  async insertPrepared(record: IntegrationProviderOperationRecord) {
    this.beforeInsert?.(record); this.beforeInsert = undefined;
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
  mergeBaseLine = `${'d'.repeat(40)}\n`;
  remoteLine = `${A}\t${binding.exactRef}\n`;
  failPush = false;
  failPushCount = 0;
  failLsRemoteCount = 0;
  remoteLineAfterFailedPush?: string;
  constructor(private readonly root: string) {}
  async run(input: { cwd: string; args: string[]; env?: Record<string, string> }): Promise<{ stdout: string }> {
    this.calls.push({ args: input.args, env: input.env });
    if (input.args[0] === '--version') return { stdout: 'git version 2.45.0' };
    if (input.args[0] === 'rev-parse') return { stdout: `${this.root}\n` };
    if (input.args[0] === 'cat-file') return { stdout: 'commit\n' };
    if (input.args[0] === 'rev-list') return { stdout: `${this.parentLine}\n` };
    if (input.args[0] === 'merge-base') return { stdout: this.mergeBaseLine };
    if (input.args[0] === 'ls-remote') {
      if (this.failLsRemoteCount > 0) {
        this.failLsRemoteCount -= 1;
        throw new Error(`provider echoed ${TOKEN}`);
      }
      return { stdout: this.remoteLine };
    }
    if (input.args[0] === 'push') {
      if (this.failPush || this.failPushCount > 0) {
        if (this.failPushCount > 0) this.failPushCount -= 1;
        if (this.remoteLineAfterFailedPush !== undefined) this.remoteLine = this.remoteLineAfterFailedPush;
        throw new Error(`provider echoed ${TOKEN}`);
      }
      const [newOid, ref] = input.args.at(-1)!.split(':');
      this.remoteLine = `${newOid}\t${ref}\n`;
      return { stdout: '' };
    }
    throw new Error(`unexpected git call ${input.args[0]}`);
  }
}

async function fixture(credential: IntegrationPushCredential | null = {
  token: TOKEN, mode: 'github_app', repositoryId: 123, configuredRepositoryId: binding.repositoryId,
  configuredRepositoryOwner: 'org', configuredRepositoryName: 'repo', installationId: 456,
}) {
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
    resolveRepository: async () => ({
      worktreePath: root, remoteUrl: 'https://github.com/org/repo.git', repositoryOwner: 'org', repositoryName: 'repo',
    }),
    resolveGithubToken: async () => credential ?? undefined,
    githubAppInstallationId: 456,
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
  return { root, host, capabilityService, gateway, git, operationStorage, operationService, issue, push, disableTarget: () => { active = false; } };
}

function exactPushInput() {
  return {
    tenantId: binding.tenantId, ownerUserId: 'owner-1', repositoryId: binding.repositoryId,
    integrationTaskId: binding.integrationTaskId, candidateId: binding.candidateId,
    revision: binding.revision, exactRef: binding.exactRef, expectedOldOid: A, newOid: B,
    fence: { workflowEpoch: binding.workflowEpoch, laneEpoch: binding.laneEpoch,
      candidateId: binding.candidateId, candidateRevision: binding.revision, executionId: 'compose-1' },
  };
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

  it('accepts a PAT only when its GitHub-probed repository identity matches the capability repository', async () => {
    const accepted = await fixture({ token: TOKEN, mode: 'personal_access_token', repositoryId: 123,
      configuredRepositoryId: binding.repositoryId, configuredRepositoryOwner: 'org', configuredRepositoryName: 'repo' });
    try {
      const issued = await accepted.issue();
      await expect(accepted.push(issued.capabilityToken)).resolves.toMatchObject({ pushed: true });
    } finally { await rm(accepted.root, { recursive: true, force: true }); }

    for (const credential of [
      { token: TOKEN, mode: 'personal_access_token' as const, repositoryId: 123,
        configuredRepositoryId: 'github-id:999', configuredRepositoryOwner: 'org', configuredRepositoryName: 'repo' },
      { token: TOKEN, mode: 'personal_access_token' as const, repositoryId: 123,
        configuredRepositoryId: binding.repositoryId, configuredRepositoryOwner: 'other', configuredRepositoryName: 'repo' },
    ]) {
      const rejected = await fixture(credential);
      try {
        const issued = await rejected.issue();
        await expect(rejected.push(issued.capabilityToken)).rejects.toMatchObject({ code: 'credential_unavailable' });
      } finally { await rm(rejected.root, { recursive: true, force: true }); }
    }
  });

  it('fails closed when the GitHub App token is missing or bound to another installation', async () => {
    for (const credential of [
      null,
      { token: TOKEN, mode: 'github_app' as const, repositoryId: 123, configuredRepositoryId: binding.repositoryId,
        configuredRepositoryOwner: 'org', configuredRepositoryName: 'repo', installationId: 999 },
    ]) {
      const f = await fixture(credential);
      try {
        const issued = await f.issue();
        await expect(f.push(issued.capabilityToken)).rejects.toMatchObject({ code: 'credential_unavailable' });
      } finally { await rm(f.root, { recursive: true, force: true }); }
    }
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

  it('allows a controlled rebase only onto the immutable base after real base divergence', async () => {
    const f = await fixture();
    try {
      f.git.parentLine = `${B} ${binding.expectedBaseOid}`;
      const issued = await f.issue();
      await expect(f.push(issued.capabilityToken)).resolves.toMatchObject({ pushed: true, commitOid: B });
      expect(f.git.calls.find((call) => call.args[0] === 'push')?.args).toContain(
        `--force-with-lease=${binding.exactRef}:${binding.expectedOldOid}`,
      );
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('rejects a rebase rewrite when the immutable base is already an ancestor of the old head', async () => {
    const f = await fixture();
    try {
      f.git.parentLine = `${B} ${binding.expectedBaseOid}`;
      f.git.mergeBaseLine = `${binding.expectedBaseOid}\n`;
      const issued = await f.issue();
      await expect(f.push(issued.capabilityToken)).rejects.toMatchObject({ code: 'parent_mismatch' });
      await expect(f.capabilityService.verify(issued.capabilityToken)).resolves.toMatchObject({ status: 'active' });
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(0);
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

  it('retries transient exact-ref reads before the controlled push', async () => {
    const f = await fixture();
    try {
      const issued = await f.issue();
      f.git.failLsRemoteCount = 2;
      await expect(f.push(issued.capabilityToken)).resolves.toMatchObject({ pushed: true, commitOid: B });
      expect(f.git.calls.filter((call) => call.args[0] === 'ls-remote')).toHaveLength(3);
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(1);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('reports exhausted exact-ref reads separately without consuming the capability', async () => {
    const f = await fixture();
    try {
      const issued = await f.issue();
      f.git.failLsRemoteCount = 3;
      await expect(f.push(issued.capabilityToken)).rejects.toMatchObject({ code: 'remote_read_failed', retryable: true });
      await expect(f.capabilityService.verify(issued.capabilityToken)).resolves.toMatchObject({ status: 'active' });
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(0);
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

  it('reconciles an ambiguous push that actually applied without a second write', async () => {
    const f = await fixture();
    const input = exactPushInput();
    try {
      f.git.failPushCount = 1;
      f.git.remoteLineAfterFailedPush = `${B}\t${binding.exactRef}\n`;
      await expect(f.gateway.pushExact(input)).resolves.toBeUndefined();
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(1);
      expect([...f.operationStorage.records.values()][0]).toMatchObject({
        kind: 'push_ref', state: 'succeeded', attemptCount: 1,
        expected: { oldOid: A, newOid: B }, receipt: { newOid: B, reconciled: true },
      });
      await expect(f.gateway.pushExact({ ...input, expectedOldOid: B })).resolves.toBeUndefined();
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(1);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('retries once with a separate ledger operation after proving the first push left the ref unchanged', async () => {
    const f = await fixture();
    try {
      f.git.failPushCount = 1;
      await expect(f.gateway.pushExact(exactPushInput())).rejects.toMatchObject({ code: 'push_failed_unknown' });
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(1);
      await expect(f.gateway.pushExact(exactPushInput())).resolves.toBeUndefined();
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(2);
      expect([...f.operationStorage.records.values()]).toEqual(expect.arrayContaining([
        expect.objectContaining({ state: 'failed', attemptCount: 1,
          receipt: expect.objectContaining({ actualOid: A, verifiedNotApplied: true }) }),
        expect.objectContaining({ state: 'succeeded', attemptCount: 1,
          receipt: expect.objectContaining({ newOid: B, recoveredAfterVerifiedOld: true }) }),
      ]));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('never performs a third push when the single verified-old retry is also ambiguous and unapplied', async () => {
    const f = await fixture();
    try {
      f.git.failPushCount = 2;
      await expect(f.gateway.pushExact(exactPushInput())).rejects.toMatchObject({ code: 'push_failed_unknown' });
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(1);
      await expect(f.gateway.pushExact(exactPushInput())).rejects.toMatchObject({ code: 'push_failed_unknown' });
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(2);
      expect([...f.operationStorage.records.values()]).toHaveLength(2);
      expect([...f.operationStorage.records.values()]).toEqual(expect.arrayContaining([
        expect.objectContaining({ state: 'failed' }),
        expect.objectContaining({ state: 'unknown', receipt: expect.objectContaining({ outcome: 'quiescence_observed' }) }),
      ]));
      await expect(f.gateway.pushExact(exactPushInput())).rejects.toMatchObject({ code: 'push_failed_unknown' });
      expect([...f.operationStorage.records.values()].every((operation) => operation.state === 'failed')).toBe(true);
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(2);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('recovers the exact legacy needs_human receipt that misclassified an unchanged old ref', async () => {
    const f = await fixture();
    try {
      f.git.failPushCount = 1;
      f.git.remoteLineAfterFailedPush = `${'c'.repeat(40)}\t${binding.exactRef}\n`;
      await expect(f.gateway.pushExact(exactPushInput())).rejects.toMatchObject({ code: 'push_failed_unknown' });
      const legacy = [...f.operationStorage.records.values()][0]!;
      f.operationStorage.records.set(legacy.operationKey, {
        ...legacy,
        receipt: { ref: binding.exactRef, actualOid: A, expectedNew: B },
      });
      f.git.remoteLine = `${A}\t${binding.exactRef}\n`;
      f.git.remoteLineAfterFailedPush = undefined;

      await expect(f.gateway.pushExact(exactPushInput())).resolves.toBeUndefined();
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(2);
      expect([...f.operationStorage.records.values()]).toEqual(expect.arrayContaining([
        expect.objectContaining({ state: 'needs_human', attemptCount: 1 }),
        expect.objectContaining({ state: 'succeeded', attemptCount: 1,
          receipt: expect.objectContaining({ recoveryOf: legacy.operationKey }) }),
      ]));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('does not retry when reconciliation sees a third-party OID or cannot see the exact ref', async () => {
    for (const remoteLine of [`${'c'.repeat(40)}\t${binding.exactRef}\n`, '']) {
      const f = await fixture();
      try {
        f.git.failPushCount = 1;
        f.git.remoteLineAfterFailedPush = remoteLine;
        await expect(f.gateway.pushExact(exactPushInput())).rejects.toMatchObject({ code: 'push_failed_unknown' });
        expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(1);
        expect([...f.operationStorage.records.values()][0]?.state).toBe(remoteLine ? 'needs_human' : 'unknown');
        await expect(f.gateway.pushExact(exactPushInput())).rejects.toMatchObject({ code: 'push_failed_unknown' });
        expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(1);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    }
  });

  it('reconciles a durable executing intent found before replay without issuing another push', async () => {
    const f = await fixture();
    const input = exactPushInput();
    try {
      const operationKey = integrationProviderOperationKey({
        repositoryId: input.repositoryId, candidateId: input.candidateId,
        candidateRevision: input.revision, kind: 'push_ref', target: `${input.exactRef}@${input.newOid}`,
      });
      const prepared = await f.operationService.prepare({
        operationKey, kind: 'push_ref', repositoryId: input.repositoryId, fence: input.fence,
        expected: { ref: input.exactRef, oldOid: input.expectedOldOid, newOid: input.newOid },
        command: { ref: input.exactRef, oldOid: input.expectedOldOid, newOid: input.newOid },
      });
      await f.operationStorage.compareAndSet({ id: prepared.id, expectedState: 'prepared', nextState: 'executing', patch: { attemptCount: 1 } });
      f.git.remoteLine = `${B}\t${binding.exactRef}\n`;

      await expect(f.gateway.pushExact(input)).resolves.toBeUndefined();
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(0);
      expect([...f.operationStorage.records.values()][0]).toMatchObject({
        state: 'succeeded', receipt: { ref: binding.exactRef, oldOid: A, newOid: B, reconciled: true },
      });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('does not reconcile or duplicate a concurrent in-flight push that wins between get and prepare', async () => {
    const f = await fixture();
    try {
      f.operationStorage.beforeInsert = (record) => {
        f.operationStorage.records.set(record.operationKey, { ...record, state: 'executing', attemptCount: 1 });
      };
      await expect(f.gateway.pushExact(exactPushInput())).rejects.toMatchObject({
        code: 'push_failed_unknown', retryable: true,
      });
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(0);
      expect([...f.operationStorage.records.values()][0]).toMatchObject({ state: 'executing', attemptCount: 1 });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('allows server compose to re-parent a single commit onto an advanced authoritative base', async () => {
    const f = await fixture();
    const advancedBase = 'c'.repeat(40);
    f.git.parentLine = `${B} ${advancedBase}`;
    try {
      await expect(f.gateway.pushExact({
        tenantId: binding.tenantId, ownerUserId: 'owner-1', repositoryId: binding.repositoryId,
        integrationTaskId: binding.integrationTaskId, candidateId: binding.candidateId,
        revision: binding.revision, exactRef: binding.exactRef, expectedOldOid: A, newOid: B,
        rebaseParentOid: advancedBase,
        fence: { workflowEpoch: binding.workflowEpoch, laneEpoch: binding.laneEpoch,
          candidateId: binding.candidateId, candidateRevision: binding.revision, executionId: 'compose-rebase' },
      })).resolves.toBeUndefined();
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(1);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('verifies a succeeded ledger receipt and exact remote head on post-bind replay without constructing a new intent', async () => {
    const f = await fixture();
    const first = {
      tenantId: binding.tenantId, ownerUserId: 'owner-1', repositoryId: binding.repositoryId,
      integrationTaskId: binding.integrationTaskId, candidateId: binding.candidateId,
      revision: binding.revision, exactRef: binding.exactRef, expectedOldOid: A, newOid: B,
      fence: { workflowEpoch: binding.workflowEpoch, laneEpoch: binding.laneEpoch,
        candidateId: binding.candidateId, candidateRevision: binding.revision, executionId: 'compose-1' },
    };
    try {
      await f.gateway.pushExact(first);
      f.git.remoteLine = `${B}\t${binding.exactRef}\n`;
      await expect(f.gateway.pushExact({ ...first, expectedOldOid: B })).resolves.toBeUndefined();
      expect(f.git.calls.filter((call) => call.args[0] === 'push')).toHaveLength(1);
      expect(f.operationStorage.records.size).toBe(1);
      expect([...f.operationStorage.records.values()][0]).toMatchObject({
        state: 'succeeded', expected: { ref: binding.exactRef, oldOid: A, newOid: B },
        receipt: { ref: binding.exactRef, oldOid: A, newOid: B },
      });
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
