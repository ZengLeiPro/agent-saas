import { describe, expect, it, vi } from 'vitest';

import type { Kubectl, KubectlResult } from './kubectl.js';
import { SandboxBusyError, SandboxManager } from './sandboxManager.js';
import { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import { baseConfig, noopLogger } from './sandboxManagerTestFixtures.js';
import { DELETION_GENERATION_ANNOTATION, activeInvocationLeaseAnnotationKey } from './sandboxLifecyclePolicy.js';

const identity = {
  workspaceId: 'ws_kaiyan__u1',
  sessionId: 'session-1',
  sandboxScopeId: 'scope-1',
};

function status(extraAnnotations: Record<string, string> = {}) {
  return {
    phase: 'Running',
    raw: {
      metadata: {
        uid: 'sandbox-uid-1',
        resourceVersion: 'resource-version-1',
        annotations: {
          'agent-saas.kaiyan.net/workspace-id': identity.workspaceId,
          'agent-saas.kaiyan.net/session-id': identity.sessionId,
          'agent-saas.kaiyan.net/sandbox-scope-id': identity.sandboxScopeId,
          'agent-saas.kaiyan.net/mount-subpath': identity.workspaceId,
          ...extraAnnotations,
        },
      },
    },
  };
}

function managedStatus(input: {
  phase: string;
  createdAt: string;
  lastActiveAt: string;
  workloadClass: string;
  terminalState?: string;
  terminalAt?: string;
}) {
  const current = status({
    'agent-saas.kaiyan.net/created-at': input.createdAt,
    'agent-saas.kaiyan.net/last-active-at': input.lastActiveAt,
    'agent-saas.kaiyan.net/workload-descriptor': JSON.stringify({ class: input.workloadClass }),
    ...(input.terminalState ? { 'agent-saas.kaiyan.net/terminal-state': input.terminalState } : {}),
    ...(input.terminalAt ? { 'agent-saas.kaiyan.net/terminal-at': input.terminalAt } : {}),
  });
  current.phase = input.phase;
  (current.raw.metadata as any).labels = { 'agent-saas.kaiyan.net/workload-class': input.workloadClass };
  return current;
}

function setup(activeRegistry?: ActiveSandboxRegistry) {
  // Keep kubectl observable so lifecycle patches and preconditioned deletes can be asserted exactly.
  const run = vi.fn(async (_args: string[]): Promise<KubectlResult> => ({
    stdout: '', stderr: '', exitCode: 0, signal: null,
  }));
  const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger, activeRegistry);
  return { manager, run };
}

describe('SandboxManager lifecycle mutations', () => {
  // Cleanup and capacity eviction share the same serialized, fresh-state deletion gate.
  it('clears stale terminal receipts when an existing scope becomes active again', async () => {
    const { manager, run } = setup();
    await (manager as any).patchWorkloadDescriptor('as-task', { class: 'cron' });
    const patchArgs = run.mock.calls.at(-1)![0];
    const payload = JSON.parse(patchArgs[4]!) as any;
    expect(payload.metadata).toEqual({
      labels: { 'agent-saas.kaiyan.net/workload-class': 'cron' },
      annotations: {
        'agent-saas.kaiyan.net/workload-descriptor': JSON.stringify({ class: 'cron' }),
        'agent-saas.kaiyan.net/last-active-at': expect.any(String),
        'agent-saas.kaiyan.net/terminal-state': null,
        'agent-saas.kaiyan.net/terminal-at': null,
        'agent-saas.kaiyan.net/terminal-outcome': null,
        'agent-saas.kaiyan.net/retention-deadline': null,
      },
    });
  });

  it('updates terminal annotations only after exact identity verification and CAS fencing', async () => {
    const { manager, run } = setup();
    vi.spyOn(manager, 'getStatus').mockResolvedValue(status({
      'agent-saas.kaiyan.net/activity-generation': 'generation-current',
    }));
    const update = {
      ...identity,
      terminalState: 'failed' as const,
      terminalAt: '2026-08-30T00:00:00.000Z',
      outcome: { reason: 'probe failed' },
      retentionDeadline: '2026-08-30T00:15:00.000Z',
      expectedActivityGeneration: 'generation-current',
    };

    await expect(manager.updateLifecycle(update)).resolves.toEqual({
      name: manager.ref(identity).name,
      retentionDeadline: update.retentionDeadline,
    });
    const patchArgs = run.mock.calls.at(-1)![0];
    expect(patchArgs.slice(0, 3)).toEqual(['patch', `sandbox/${manager.ref(identity).name}`, '--type=json']);
    const payload = JSON.parse(patchArgs[4]!) as Array<{ op: string; path: string; value?: unknown }>;
    expect(payload).toEqual(expect.arrayContaining([
      { op: 'test', path: '/metadata/uid', value: 'sandbox-uid-1' },
      { op: 'test', path: '/metadata/resourceVersion', value: 'resource-version-1' },
      expect.objectContaining({ path: '/metadata/annotations/agent-saas.kaiyan.net~1terminal-state', value: 'failed' }),
      expect.objectContaining({ path: '/metadata/annotations/agent-saas.kaiyan.net~1terminal-at', value: update.terminalAt }),
      expect.objectContaining({ path: '/metadata/annotations/agent-saas.kaiyan.net~1terminal-outcome', value: JSON.stringify(update.outcome) }),
      expect.objectContaining({ path: '/metadata/annotations/agent-saas.kaiyan.net~1retention-deadline', value: update.retentionDeadline }),
    ]));
  });

  it('keeps terminalAt monotonic when an older terminal receipt retries after a newer one', async () => {
    const { manager, run } = setup();
    const newerAt = '2026-08-30T00:10:00.000Z';
    const newerDeadline = '2026-08-30T00:25:00.000Z';
    const newerStatus = status({
      'agent-saas.kaiyan.net/terminal-state': 'completed',
      'agent-saas.kaiyan.net/terminal-at': newerAt,
      'agent-saas.kaiyan.net/retention-deadline': newerDeadline,
    });
    vi.spyOn(manager, 'getStatus')
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(newerStatus);

    await manager.updateLifecycle({
      ...identity, terminalState: 'completed', terminalAt: newerAt, retentionDeadline: newerDeadline,
    });
    await expect(manager.updateLifecycle({
      ...identity,
      terminalState: 'failed',
      terminalAt: '2026-08-30T00:05:00.000Z',
      retentionDeadline: '2026-08-30T00:20:00.000Z',
    })).resolves.toEqual({ name: manager.ref(identity).name, retentionDeadline: newerDeadline });

    expect(run).toHaveBeenCalledOnce();
  });

  it('ignores a stale terminal receipt when a newer admission generation won even if its clock is behind', async () => {
    const { manager, run } = setup();
    vi.spyOn(manager, 'getStatus').mockResolvedValue(status({
      'agent-saas.kaiyan.net/last-active-at': '2026-08-30T00:10:00.000Z',
      'agent-saas.kaiyan.net/activity-generation': 'generation-new',
    }));

    await expect(manager.updateLifecycle({
      ...identity,
      terminalState: 'completed',
      terminalAt: '2026-08-30T00:15:00.000Z',
      retentionDeadline: '2026-08-30T00:20:00.000Z',
      expectedActivityGeneration: 'generation-old',
    })).resolves.toEqual({ name: manager.ref(identity).name });
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a delayed lifecycle patch after the Sandbox is deleted and recreated with the same name', async () => {
    const { manager, run } = setup();
    const recreated = status();
    (recreated.raw.metadata as any).uid = 'sandbox-uid-2';
    (recreated.raw.metadata as any).resourceVersion = 'resource-version-2';
    vi.spyOn(manager, 'getStatus')
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(recreated);
    run.mockResolvedValueOnce({
      stdout: '', stderr: 'jsonpatch test operation failed', exitCode: 1, signal: null,
    });

    await expect(manager.updateLifecycle({
      ...identity, terminalState: 'failed', terminalAt: '2026-08-30T00:05:00.000Z',
    })).rejects.toThrow(/同名重建/u);
    expect(run).toHaveBeenCalledOnce();
  });

  it('keeps legacy 30m cleanup in shadow and applies workload deadlines only in enforce', async () => {
    const now = new Date('2026-08-30T00:10:00.000Z');
    const sandbox = {
      name: 'as-task',
      phase: 'Paused',
      createdAt: '2026-08-30T00:00:00.000Z',
      lastActiveAt: '2026-08-30T00:00:00.000Z',
      workloadClass: 'taskboard' as const,
      workloadDescriptor: { class: 'taskboard' as const },
      terminalState: 'completed' as const,
      terminalAt: '2026-08-30T00:00:00.000Z',
    };
    const cleanup = async (mode: 'shadow' | 'enforce') => {
      const { manager } = setup();
      (manager as any).config.lifecyclePolicyMode = mode;
      (manager as any).config.sandboxTtlMs = 30 * 60_000;
      vi.spyOn(manager, 'listManagedSandboxes').mockResolvedValue([sandbox]);
      vi.spyOn(manager, 'getStatus').mockResolvedValue(managedStatus(sandbox));
      const remove = vi.fn(async () => [] as string[]);
      (manager as any).deleteSandboxAndReclaimNetwork = remove;
      (manager as any).cleanupOrphanSnat = vi.fn(async () => ({ deleted: [], unexpected: [] }));
      const report = await manager.cleanupSandboxes({ now });
      return { report, remove };
    };

    const shadow = await cleanup('shadow');
    expect(shadow.report.deleted).toEqual([]);
    expect(shadow.report.policyMode).toBe('shadow');
    expect(shadow.report.decisionCounts).toMatchObject({ 'delete-terminal-expired': 1 });

    const enforce = await cleanup('enforce');
    expect(enforce.report.deleted).toEqual(['as-task']);
    expect(enforce.remove).toHaveBeenCalledWith('as-task', {
      uid: 'sandbox-uid-1', resourceVersion: 'resource-version-1',
    });
  });

  it('deletes only the exact fenced scope, is idempotent when missing, and rejects busy/protected sandboxes', async () => {
    const { manager } = setup();
    const name = manager.ref(identity).name;
    const deletion = { ...identity, deletionGeneration: 'generation-1' };
    const fencedStatus = status({ [DELETION_GENERATION_ANNOTATION]: deletion.deletionGeneration });
    const remove = vi.fn(async () => [] as string[]);
    (manager as any).deleteSandboxAndReclaimNetwork = remove;
    const getStatus = vi.spyOn(manager, 'getStatus');

    getStatus.mockResolvedValueOnce(null);
    await expect(manager.deleteByScope(deletion)).resolves.toEqual({ name, deleted: false, missing: true });

    getStatus.mockResolvedValue(fencedStatus);
    await expect(manager.deleteByScope(deletion, { busySandboxNames: new Set([name]) }))
      .rejects.toBeInstanceOf(SandboxBusyError);

    const leasedStatus = status({
      [DELETION_GENERATION_ANNOTATION]: deletion.deletionGeneration,
      [activeInvocationLeaseAnnotationKey('inv-1')]: JSON.stringify({
        invocationKey: 'inv-1',
        until: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    getStatus.mockResolvedValue(leasedStatus);
    await expect(manager.deleteByScope(deletion)).rejects.toBeInstanceOf(SandboxBusyError);

    getStatus.mockResolvedValue(fencedStatus);
    await expect(manager.deleteByScope(deletion)).resolves.toEqual({ name, deleted: true, missing: false });
    expect(remove).toHaveBeenCalledOnce();
  });

  it('rejects an old DELETE after restore advances generation while its initial status read is blocked', async () => {
    const { manager } = setup();
    let currentGeneration = 'generation-1';
    let firstStatusStarted!: () => void;
    let releaseFirstStatus!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstStatusStarted = resolve; });
    const firstBlocked = new Promise<void>((resolve) => { releaseFirstStatus = resolve; });
    let calls = 0;
    vi.spyOn(manager, 'getStatus').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        firstStatusStarted();
        await firstBlocked;
      }
      return status({ [DELETION_GENERATION_ANNOTATION]: currentGeneration });
    });
    const remove = vi.fn(async () => [] as string[]);
    (manager as any).deleteSandboxAndReclaimNetwork = remove;

    const oldDelete = manager.deleteByScope({ ...identity, deletionGeneration: 'generation-1' });
    await firstStarted;
    await manager.advanceDeletionGeneration({
      ...identity,
      previousDeletionGeneration: 'generation-1',
      deletionGeneration: 'generation-2',
    });
    currentGeneration = 'generation-2';
    const warmupCreatedNewScope = true;
    releaseFirstStatus();

    await expect(oldDelete).resolves.toEqual({
      name: manager.ref(identity).name,
      deleted: false,
      missing: false,
      stale: true,
    });
    expect(warmupCreatedNewScope).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });

  it('recreated Sandbox 以 opaque token 初始化，不依赖跨节点墙钟；已有链仍校验 previous token', async () => {
    const { manager } = setup();
    const createdAt = Date.parse('2026-08-30T00:00:00.000Z');
    const getStatus = vi.spyOn(manager, 'getStatus');
    getStatus.mockResolvedValueOnce(status({
      'agent-saas.kaiyan.net/created-at': new Date(createdAt).toISOString(),
    }));

    await expect(manager.advanceDeletionGeneration({
      ...identity,
      previousDeletionGeneration: 'generation-before-restore',
      deletionGeneration: `${createdAt}-same-millisecond`,
    })).resolves.toMatchObject({ updated: true, missing: false });

    getStatus.mockResolvedValueOnce(status({
      [DELETION_GENERATION_ANNOTATION]: 'generation-current',
    }));
    await expect(manager.advanceDeletionGeneration({
      ...identity,
      previousDeletionGeneration: 'generation-stale',
      deletionGeneration: 'generation-next',
    })).rejects.toBeInstanceOf(SandboxBusyError);
  });

  it('在 cleanup 删除前再次检查 process-local activity', async () => {
    const activeRegistry = new ActiveSandboxRegistry();
    const { manager } = setup(activeRegistry);
    (manager as any).config.lifecyclePolicyMode = 'enforce';
    vi.spyOn(manager, 'listManagedSandboxes').mockResolvedValue([{
      name: 'as-race',
      phase: 'Paused',
      createdAt: '2026-08-29T23:00:00.000Z',
      lastActiveAt: '2026-08-29T23:00:00.000Z',
      workloadClass: 'interactive',
      workloadDescriptor: { class: 'interactive' },
    }]);
    let markStatusStarted!: () => void;
    let releaseStatus!: () => void;
    const statusStarted = new Promise<void>((resolve) => { markStatusStarted = resolve; });
    const statusReady = new Promise<void>((resolve) => { releaseStatus = resolve; });
    vi.spyOn(manager, 'getStatus').mockImplementation(async () => {
      markStatusStarted();
      await statusReady;
      return status();
    });
    const remove = vi.fn(async () => [] as string[]);
    (manager as any).deleteSandboxAndReclaimNetwork = remove;
    (manager as any).cleanupOrphanSnat = vi.fn(async () => ({ deleted: [], unexpected: [] }));

    const cleanup = manager.cleanupSandboxes({ now: new Date('2026-08-30T00:00:00.000Z') });
    await statusStarted;
    const releaseActive = activeRegistry.acquire('as-race', 'inv-race');
    releaseStatus();
    const report = await cleanup;
    releaseActive();

    expect(report.deleted).toEqual([]);
    expect(report.skippedBusy).toEqual(['as-race']);
    expect(remove).not.toHaveBeenCalled();
  });

  it('rechecks the latest lastActiveAt before deleting a stale inventory candidate', async () => {
    const { manager } = setup();
    (manager as any).config.lifecyclePolicyMode = 'shadow';
    (manager as any).config.sandboxTtlMs = 30 * 60_000;
    vi.spyOn(manager, 'listManagedSandboxes').mockResolvedValue([{
      name: 'as-fresh-touch', phase: 'Paused', createdAt: '2026-08-29T23:00:00.000Z',
      lastActiveAt: '2026-08-29T23:00:00.000Z', workloadClass: 'interactive',
      workloadDescriptor: { class: 'interactive' },
    }]);
    const latest = status({ 'agent-saas.kaiyan.net/last-active-at': '2026-08-30T00:00:00.000Z' });
    latest.phase = 'Paused';
    vi.spyOn(manager, 'getStatus').mockResolvedValue(latest);
    const remove = vi.fn(async () => [] as string[]);
    (manager as any).deleteSandboxAndReclaimNetwork = remove;
    (manager as any).cleanupOrphanSnat = vi.fn(async () => ({ deleted: [], unexpected: [] }));

    const report = await manager.cleanupSandboxes({ now: new Date('2026-08-30T00:01:00.000Z') });

    expect(report.deleted).toEqual([]);
    expect(report.skippedBusy).toEqual(['as-fresh-touch']);
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(['resumed', 'ensuring'] as const)('capacity eviction skips a Paused inventory candidate that is %s', async (state) => {
    const { manager } = setup();
    (manager as any).config.maxRunningSandboxes = 1;
    (manager as any).config.lifecycleEnabled = true;
    const candidateName = 'as-capacity-race';
    vi.spyOn(manager, 'listManagedSandboxes').mockResolvedValue([{
      name: candidateName, phase: 'Paused', createdAt: '2026-08-29T23:00:00.000Z',
      lastActiveAt: '2026-08-29T23:00:00.000Z', workloadClass: 'interactive',
      workloadDescriptor: { class: 'interactive' },
    }]);
    vi.spyOn(manager, 'getStatus').mockResolvedValue({ ...status(), phase: state === 'resumed' ? 'Running' : 'Paused' });
    if (state === 'ensuring') (manager as any).ensureInFlight.set(candidateName, { ref: {}, promise: new Promise(() => {}) });
    const remove = vi.fn(async () => [] as string[]);
    (manager as any).deleteSandboxAndReclaimNetwork = remove;
    const ref = (manager as any).ref({ workspaceId: 'ws-new', sessionId: 'session-new' });

    await expect((manager as any).reserveCapacity(ref, {})).rejects.toThrow(/capacity exhausted/);
    expect(remove).not.toHaveBeenCalled();
  });

  it('retains the old 30m shadow cleanup for inactive unknown sandboxes', async () => {
    const { manager } = setup();
    (manager as any).config.lifecyclePolicyMode = 'shadow';
    (manager as any).config.sandboxTtlMs = 30 * 60_000;
    vi.spyOn(manager, 'listManagedSandboxes').mockResolvedValue([{
      name: 'as-legacy',
      phase: 'Paused',
      createdAt: '2026-08-29T23:00:00.000Z',
      lastActiveAt: '2026-08-29T23:29:00.000Z',
      workloadClass: 'unknown',
      workloadDescriptor: { class: 'unknown' },
    }]);
    vi.spyOn(manager, 'getStatus').mockResolvedValue(managedStatus({
      phase: 'Paused', createdAt: '2026-08-29T23:00:00.000Z',
      lastActiveAt: '2026-08-29T23:29:00.000Z', workloadClass: 'unknown',
    }));
    const remove = vi.fn(async () => [] as string[]);
    (manager as any).deleteSandboxAndReclaimNetwork = remove;
    (manager as any).cleanupOrphanSnat = vi.fn(async () => ({ deleted: [], unexpected: [] }));
    const report = await manager.cleanupSandboxes({ now: new Date('2026-08-30T00:00:00.000Z') });
    expect(report.deleted).toEqual(['as-legacy']);
    expect(remove).toHaveBeenCalledWith('as-legacy', {
      uid: 'sandbox-uid-1', resourceVersion: 'resource-version-1',
    });
  });
});
