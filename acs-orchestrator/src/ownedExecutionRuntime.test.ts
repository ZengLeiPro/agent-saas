import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcsOrchestratorConfig } from './config.js';
import { createOwnedExecutionRuntime } from './ownedExecutionRuntime.js';
import { OwnershipJournal } from './ownershipJournal.js';
import { Provisioner } from './provision.js';
import type { WorkspaceRecipe } from './protocol.js';
import { SandboxManager } from './sandboxManager.js';
import { OwnershipBlockedError, ownershipIsTerminal, type OwnershipRecord } from './ownershipState.js';

vi.mock('./remoteOwnershipReconciler.js', () => ({
  reconcileRemoteOwnership: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('owned execution runtime', () => {
  it('warmup with a different ensureInput joins in-flight ensure then provision succeeds', async () => {
    let finishEnsure!: () => void;
    const ensurePending = new Promise<void>((resolve) => {
      finishEnsure = resolve;
    });
    const ensure = vi
      .spyOn(SandboxManager.prototype, 'ensureRunning')
      .mockImplementation(async function (this: SandboxManager, input) {
        await ensurePending;
        return this.ref(input);
      });
    const provision = vi.spyOn(Provisioner.prototype, 'provision').mockResolvedValue({
      status: 'ok',
      logs: [],
      metadata: {},
    });
    bindConflictingJournal();

    const runtime = createOwnedExecutionRuntime(config(), { info() {}, warn() {}, error() {} });
    const warmupInput = {
      workspaceId: 'workspace-test',
      sessionId: 'session-test',
      sandboxScopeId: 'scope-test',
      mountSubPath: 'workspaces/kaiyan/user',
    };
    const recipe: WorkspaceRecipe = {
      workspaceId: 'workspace-test',
      sessionId: 'session-test',
      sandboxScopeId: 'scope-test',
      mountSubPath: 'workspaces/kaiyan/user',
      sharedReadOnlySubPath: 'workspaces/kaiyan/shared',
      workload: { class: 'unknown' },
    };

    const warmup = runtime.sandboxManager.ensureRunning(warmupInput);
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
    const formalProvision = runtime.provisioner.provision(recipe);
    let provisionSettled = false;
    void formalProvision.then(() => { provisionSettled = true; }, () => { provisionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provision).not.toHaveBeenCalled();
    expect(provisionSettled).toBe(false);

    finishEnsure();
    await expect(warmup).resolves.toMatchObject({ workspaceId: 'workspace-test' });
    await expect(formalProvision).resolves.toMatchObject({ status: 'ok' });
    expect(ensure).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledOnce();
  });

  it('provision immediately after warmup ensure resolves does not 409', async () => {
    const ensure = vi
      .spyOn(SandboxManager.prototype, 'ensureRunning')
      .mockImplementation(async function (this: SandboxManager, input) {
        return this.ref(input);
      });
    vi.spyOn(Provisioner.prototype, 'provision').mockResolvedValue({
      status: 'ok',
      logs: [],
      metadata: {},
    });
    bindConflictingJournal();

    const runtime = createOwnedExecutionRuntime(config(), { info() {}, warn() {}, error() {} });
    const warmupInput = {
      workspaceId: 'workspace-test',
      sessionId: 'session-test',
      sandboxScopeId: 'scope-test',
      mountSubPath: 'workspaces/kaiyan/user',
    };
    const recipe: WorkspaceRecipe = {
      workspaceId: 'workspace-test',
      sessionId: 'session-test',
      sandboxScopeId: 'scope-test',
      mountSubPath: 'workspaces/kaiyan/user',
      sharedReadOnlySubPath: 'workspaces/kaiyan/shared',
      workload: { class: 'unknown' },
    };

    await runtime.sandboxManager.ensureRunning(warmupInput);
    await expect(runtime.provisioner.provision(recipe)).resolves.toMatchObject({ status: 'ok' });
    expect(ensure).toHaveBeenCalled();
  });

  it('two sessions of one workspace provision concurrently instead of rejecting the later one', async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const ensure = vi
      .spyOn(SandboxManager.prototype, 'ensureRunning')
      .mockImplementation(async function (this: SandboxManager, input) {
        if (input.sessionId === 'taskboard-first') await firstPending;
        return this.ref(input);
      });
    const provision = vi.spyOn(Provisioner.prototype, 'provision').mockResolvedValue({ status: 'ok', logs: [], metadata: {} });
    vi.spyOn(OwnershipJournal.prototype, 'reserve').mockImplementation(async (record) => record);
    vi.spyOn(OwnershipJournal.prototype, 'update').mockImplementation(async (record) => record);

    const runtime = createOwnedExecutionRuntime(config(), { info() {}, warn() {}, error() {} });
    // Per-session sandboxes: distinct scope ids, one shared NAS directory (the production layout).
    const shared = { workspaceId: 'workspace-test', mountSubPath: 'workspaces/kaiyan/user', workload: { class: 'interactive' as const } };
    const first: WorkspaceRecipe = { ...shared, sessionId: 'taskboard-first', sandboxScopeId: 'scope-test__s_taskboard-first' };
    const second: WorkspaceRecipe = { ...shared, sessionId: 'sub-second', sandboxScopeId: 'scope-test__s_sub-second' };

    const slow = runtime.provisioner.provision(first);
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
    // The first session is still inside its ensure/provision window when the second arrives.
    await expect(runtime.provisioner.provision(second)).resolves.toMatchObject({ status: 'ok' });
    releaseFirst();
    await expect(slow).resolves.toMatchObject({ status: 'ok' });
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(provision).toHaveBeenCalledTimes(2);
  });

  it('retrying provision after a failed prepare no longer stays poisoned', async () => {
    // Corresponds to the 21:52:28 retry after the first formal provision 409.
    let failReserve = true;
    const records = new Map<string, OwnershipRecord>();
    vi.spyOn(OwnershipJournal.prototype, 'reserve').mockImplementation(async (record, conflict) => {
      if (failReserve) {
        failReserve = false;
        throw new OwnershipBlockedError('foreign-prepare');
      }
      const blocking = [...records.values()].find((item) => !ownershipIsTerminal(item) && conflict(item));
      if (blocking) throw new OwnershipBlockedError(blocking.operationId);
      records.set(record.operationId, structuredClone(record));
      return record;
    });
    vi.spyOn(OwnershipJournal.prototype, 'update').mockImplementation(async (record) => {
      records.set(record.operationId, structuredClone(record));
      return record;
    });
    vi.spyOn(OwnershipJournal.prototype, 'snapshot').mockImplementation(() => ({
      available: true,
      records: [...records.values()],
    }));
    vi.spyOn(SandboxManager.prototype, 'ensureRunning').mockImplementation(async function (this: SandboxManager, input) {
      return this.ref(input);
    });
    vi.spyOn(Provisioner.prototype, 'provision').mockResolvedValue({ status: 'ok', logs: [], metadata: {} });

    const runtime = createOwnedExecutionRuntime(config(), { info() {}, warn() {}, error() {} });
    const recipe: WorkspaceRecipe = {
      workspaceId: 'workspace-test',
      sessionId: 'session-test',
      sandboxScopeId: 'scope-test',
      workload: { class: 'unknown' },
    };
    await expect(runtime.provisioner.provision(recipe)).rejects.toBeInstanceOf(OwnershipBlockedError);
    expect(runtime.ownedOperations.records().some((record) => record.resource === 'unknown')).toBe(false);
    await expect(runtime.provisioner.provision(recipe)).resolves.toMatchObject({ status: 'ok' });
    expect(runtime.ownedOperations.drainBlockers()).toBe(0);
  });

  it('two different recipes for the same sandbox serialize without ownership 409', async () => {
    let finishFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    vi.spyOn(SandboxManager.prototype, 'ensureRunning').mockImplementation(async function (this: SandboxManager, input) {
      return this.ref(input);
    });
    let provisionCalls = 0;
    const provision = vi.spyOn(Provisioner.prototype, 'provision').mockImplementation(async () => {
      provisionCalls += 1;
      if (provisionCalls === 1) await firstPending;
      return { status: 'ok', logs: [], metadata: {} };
    });
    bindConflictingJournal();

    const runtime = createOwnedExecutionRuntime(config(), { info() {}, warn() {}, error() {} });
    const base = {
      workspaceId: 'workspace-test',
      sessionId: 'session-test',
      sandboxScopeId: 'scope-test',
      mountSubPath: 'workspaces/kaiyan/user',
    };
    const first = runtime.provisioner.provision({ ...base, workload: { class: 'interactive' } });
    await vi.waitFor(() => expect(provision).toHaveBeenCalledOnce());
    const second = runtime.provisioner.provision({ ...base, workload: { class: 'unknown' } });
    finishFirst();
    await expect(first).resolves.toMatchObject({ status: 'ok' });
    await expect(second).resolves.toMatchObject({ status: 'ok' });
  });

  it('different mountSubPath does not join the same ensure fingerprint', async () => {
    let finishFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let ensureCalls = 0;
    const ensure = vi
      .spyOn(SandboxManager.prototype, 'ensureRunning')
      .mockImplementation(async function (this: SandboxManager, input) {
        const n = ++ensureCalls;
        if (n === 1) await firstPending;
        return this.ref(input);
      });
    bindConflictingJournal();

    const runtime = createOwnedExecutionRuntime(config(), { info() {}, warn() {}, error() {} });
    const shared = { workspaceId: 'workspace-test', sessionId: 'session-test', sandboxScopeId: 'scope-test' };
    const first = runtime.sandboxManager.ensureRunning({ ...shared, mountSubPath: 'workspaces/kaiyan/user-a' });
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
    const second = runtime.sandboxManager.ensureRunning({ ...shared, mountSubPath: 'workspaces/kaiyan/user-b' });
    let secondSettled = false;
    let secondValue: { mountSubPath?: string } | undefined;
    void second.then((value) => {
      secondSettled = true;
      secondValue = value;
    }, () => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondSettled).toBe(false);

    finishFirst();
    const firstRef = await first;
    const secondRef = await second;
    expect(firstRef.mountSubPath).not.toBe(secondRef.mountSubPath);
    expect(secondValue?.mountSubPath).not.toBe(firstRef.mountSubPath);
    expect(ensure.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

function bindConflictingJournal() {
  const records = new Map<string, OwnershipRecord>();
  vi.spyOn(OwnershipJournal.prototype, 'reserve').mockImplementation(async (record, conflict) => {
    const blocking = [...records.values()].find((item) => !ownershipIsTerminal(item) && conflict(item));
    if (blocking) throw new OwnershipBlockedError(blocking.operationId);
    records.set(record.operationId, structuredClone(record));
    return record;
  });
  vi.spyOn(OwnershipJournal.prototype, 'update').mockImplementation(async (record) => {
    records.set(record.operationId, structuredClone(record));
    return record;
  });
  vi.spyOn(OwnershipJournal.prototype, 'snapshot').mockImplementation(() => ({
    available: true,
    records: [...records.values()],
  }));
  return records;
}

function config(): AcsOrchestratorConfig {
  return {
    authToken: 'test-token',
    namespace: 'test-namespace',
    pvcName: 'test-workspace-pvc',
  } as AcsOrchestratorConfig;
}
