import { describe, expect, it, vi } from 'vitest';

import type { Kubectl, KubectlResult } from './kubectl.js';
import { SandboxBusyError, SandboxManager } from './sandboxManager.js';
import { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import { baseConfig, noopLogger } from './sandboxManagerTestFixtures.js';
import { activeInvocationLeaseAnnotationKey } from './sandboxLifecyclePolicy.js';

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
  // Keep kubectl observable so lifecycle annotation patches can be asserted exactly.
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
        'agent-saas.kaiyan.net/terminal-state': null,
        'agent-saas.kaiyan.net/terminal-at': null,
        'agent-saas.kaiyan.net/terminal-outcome': null,
        'agent-saas.kaiyan.net/retention-deadline': null,
      },
    });
  });

  it('updates terminal annotations only after exact identity verification', async () => {
    const { manager, run } = setup();
    vi.spyOn(manager, 'getStatus').mockResolvedValue(status());
    const update = {
      ...identity,
      terminalState: 'failed' as const,
      terminalAt: '2026-08-30T00:00:00.000Z',
      outcome: { reason: 'probe failed' },
      retentionDeadline: '2026-08-30T00:15:00.000Z',
    };

    await expect(manager.updateLifecycle(update)).resolves.toEqual({
      name: manager.ref(identity).name,
      retentionDeadline: update.retentionDeadline,
    });
    const patchArgs = run.mock.calls.at(-1)![0];
    expect(patchArgs.slice(0, 3)).toEqual(['patch', `sandbox/${manager.ref(identity).name}`, '--type=merge']);
    const payload = JSON.parse(patchArgs[4]!) as any;
    expect(payload.metadata.annotations).toMatchObject({
      'agent-saas.kaiyan.net/terminal-state': 'failed',
      'agent-saas.kaiyan.net/terminal-at': update.terminalAt,
      'agent-saas.kaiyan.net/terminal-outcome': JSON.stringify(update.outcome),
      'agent-saas.kaiyan.net/retention-deadline': update.retentionDeadline,
    });
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
    expect(enforce.remove).toHaveBeenCalledWith('as-task');
  });

  it('deletes only the exact scope, is idempotent when missing, and rejects busy/protected sandboxes', async () => {
    const { manager } = setup();
    const name = manager.ref(identity).name;
    const remove = vi.fn(async () => [] as string[]);
    (manager as any).deleteSandboxAndReclaimNetwork = remove;
    const getStatus = vi.spyOn(manager, 'getStatus');

    getStatus.mockResolvedValueOnce(null);
    await expect(manager.deleteByScope(identity)).resolves.toEqual({ name, deleted: false, missing: true });

    getStatus.mockResolvedValueOnce(status());
    await expect(manager.deleteByScope(identity, { busySandboxNames: new Set([name]) }))
      .rejects.toBeInstanceOf(SandboxBusyError);

    const leasedStatus = status({
      [activeInvocationLeaseAnnotationKey('inv-1')]: JSON.stringify({
        invocationKey: 'inv-1',
        until: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    getStatus.mockResolvedValueOnce(leasedStatus).mockResolvedValueOnce(leasedStatus);
    await expect(manager.deleteByScope(identity)).rejects.toBeInstanceOf(SandboxBusyError);

    getStatus.mockResolvedValueOnce(status()).mockResolvedValueOnce(status());
    await expect(manager.deleteByScope(identity)).resolves.toEqual({ name, deleted: true, missing: false });
    expect(remove).toHaveBeenCalledOnce();
  });

  it('rechecks process-local activity immediately before cleanup deletion', async () => {
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
    expect(remove).toHaveBeenCalledWith('as-legacy');
  });
});
