import { describe, expect, it, vi } from 'vitest';

import { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import type { Kubectl, KubectlResult } from './kubectl.js';
import { SANDBOX_NETWORK_CLEANUP_FINALIZER } from './sandboxDeletion.js';
import { SandboxBusyError, SandboxManager } from './sandboxManager.js';
import { baseConfig, noopLogger } from './sandboxManagerTestFixtures.js';
import {
  DELETION_GENERATION_ANNOTATION,
  activeInvocationLeaseAnnotationKey,
} from './sandboxLifecyclePolicy.js';

const identity = {
  workspaceId: 'ws_kaiyan__race',
  sessionId: 'session-race',
  sandboxScopeId: 'scope-race',
};

const ok = (stdout = ''): KubectlResult => ({ stdout, stderr: '', exitCode: 0, signal: null });
const conflict = (): KubectlResult => ({
  stdout: '', stderr: 'jsonpatch test failed: object has been modified', exitCode: 1, signal: null,
});

function sandboxStatus(input: {
  uid: string;
  resourceVersion: string;
  phase?: string;
  generation?: string;
  createdAt?: string;
  lastActiveAt?: string;
  workloadClass?: string;
}) {
  const workloadClass = input.workloadClass ?? 'interactive';
  return {
    phase: input.phase ?? 'Running',
    raw: {
      metadata: {
        uid: input.uid,
        resourceVersion: input.resourceVersion,
        finalizers: [SANDBOX_NETWORK_CLEANUP_FINALIZER],
        labels: { 'agent-saas.kaiyan.net/workload-class': workloadClass },
        annotations: {
          'agent-saas.kaiyan.net/workspace-id': identity.workspaceId,
          'agent-saas.kaiyan.net/session-id': identity.sessionId,
          'agent-saas.kaiyan.net/sandbox-scope-id': identity.sandboxScopeId,
          'agent-saas.kaiyan.net/mount-subpath': identity.workspaceId,
          'agent-saas.kaiyan.net/created-at': input.createdAt ?? '2026-08-30T00:00:00.000Z',
          'agent-saas.kaiyan.net/last-active-at': input.lastActiveAt ?? '2026-08-30T00:00:00.000Z',
          'agent-saas.kaiyan.net/workload-descriptor': JSON.stringify({ class: workloadClass }),
          ...(input.generation ? { [DELETION_GENERATION_ANNOTATION]: input.generation } : {}),
        },
      },
      spec: { paused: input.phase === 'Paused' },
      status: { phase: input.phase ?? 'Running' },
    },
  };
}

function cloneStatus<T>(value: T): T {
  return structuredClone(value);
}

function jsonPatchPreconditions(args: string[]): { uid?: string; resourceVersion?: string } {
  const patch = JSON.parse(args[4] ?? '[]') as Array<{ op?: string; path?: string; value?: unknown }>;
  return {
    uid: patch.find((entry) => entry.op === 'test' && entry.path === '/metadata/uid')?.value as string | undefined,
    resourceVersion: patch.find((entry) => entry.op === 'test' && entry.path === '/metadata/resourceVersion')?.value as string | undefined,
  };
}

describe('Sandbox Kubernetes mutation concurrency fences', () => {
  it('rejects an old generation patch after another ACS instance observes a recreated CR', async () => {
    let current = sandboxStatus({ uid: 'uid-old', resourceVersion: 'rv-old', generation: 'generation-1' });
    let oldPatchStarted!: () => void;
    let releaseOldPatch!: () => void;
    const oldPatchPending = new Promise<void>((resolve) => { oldPatchStarted = resolve; });
    const oldPatchBlocked = new Promise<void>((resolve) => { releaseOldPatch = resolve; });
    const run = vi.fn(async (args: string[]): Promise<KubectlResult> => {
      if (args[0] !== 'patch' || args[2] !== '--type=json') return ok();
      const expected = jsonPatchPreconditions(args);
      if (expected.uid === 'uid-old') {
        oldPatchStarted();
        await oldPatchBlocked;
      }
      const metadata = current.raw.metadata;
      if (metadata.uid !== expected.uid || metadata.resourceVersion !== expected.resourceVersion) return conflict();
      const patch = JSON.parse(args[4] ?? '[]') as Array<{ path?: string; value?: unknown }>;
      const generation = patch.find((entry) => entry.path?.includes('deletion-generation'))?.value;
      if (typeof generation === 'string') metadata.annotations[DELETION_GENERATION_ANNOTATION] = generation;
      metadata.resourceVersion = `${metadata.resourceVersion}-next`;
      return ok();
    });
    const managerA = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    const managerB = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(managerA, 'getStatus').mockImplementation(async () => cloneStatus(current));
    vi.spyOn(managerB, 'getStatus').mockImplementation(async () => cloneStatus(current));

    const oldAdvance = managerA.advanceDeletionGeneration({
      ...identity, previousDeletionGeneration: 'generation-1', deletionGeneration: 'generation-2',
    });
    await oldPatchPending;
    current = sandboxStatus({ uid: 'uid-new', resourceVersion: 'rv-new', generation: 'generation-new-base' });
    await managerB.advanceDeletionGeneration({
      ...identity, previousDeletionGeneration: 'generation-new-base', deletionGeneration: 'generation-3',
    });
    releaseOldPatch();

    await expect(oldAdvance).rejects.toBeInstanceOf(SandboxBusyError);
    expect(current.raw.metadata.uid).toBe('uid-new');
    expect(current.raw.metadata.annotations[DELETION_GENERATION_ANNOTATION]).toBe('generation-3');
  });

  it('fails regular cleanup closed when a fast-path invocation lease changes resourceVersion before DELETE', async () => {
    const now = new Date('2026-08-30T01:00:00.000Z');
    let current = sandboxStatus({ uid: 'uid-delete', resourceVersion: 'rv-delete', phase: 'Paused' });
    let deleteStarted!: () => void;
    let releaseDelete!: () => void;
    const deletePending = new Promise<void>((resolve) => { deleteStarted = resolve; });
    const deleteBlocked = new Promise<void>((resolve) => { releaseDelete = resolve; });
    let deletePreconditions: { uid?: string; resourceVersion?: string } | undefined;
    const run = vi.fn(async (args: string[], options: { input?: string } = {}): Promise<KubectlResult> => {
      if (args[0] === 'patch' && args[2] === '--type=merge') {
        const payload = JSON.parse(args[4] ?? '{}') as { metadata?: { annotations?: Record<string, string> } };
        Object.assign(current.raw.metadata.annotations, payload.metadata?.annotations ?? {});
        current.raw.metadata.resourceVersion = 'rv-leased';
        return ok();
      }
      if (args[0] === 'delete' && args[1]?.startsWith('--raw=')) {
        deletePreconditions = (JSON.parse(options.input ?? '{}') as { preconditions?: typeof deletePreconditions }).preconditions;
        deleteStarted();
        await deleteBlocked;
        return current.raw.metadata.uid === deletePreconditions?.uid
          && current.raw.metadata.resourceVersion === deletePreconditions?.resourceVersion ? ok() : conflict();
      }
      return ok();
    });
    const config = { ...baseConfig(), lifecyclePolicyMode: 'shadow' as const, sandboxTtlMs: 30 * 60_000 };
    const managerA = new SandboxManager(config, { run } as unknown as Kubectl, noopLogger, new ActiveSandboxRegistry());
    const managerB = new SandboxManager(config, { run } as unknown as Kubectl, noopLogger, new ActiveSandboxRegistry());
    const name = managerA.ref(identity).name;
    vi.spyOn(managerA, 'listManagedSandboxes').mockResolvedValue([{
      name, phase: 'Paused', createdAt: '2026-08-30T00:00:00.000Z', lastActiveAt: '2026-08-30T00:00:00.000Z',
      workloadClass: 'interactive', workloadDescriptor: { class: 'interactive' },
    }]);
    vi.spyOn(managerA, 'getStatus').mockImplementation(async () => cloneStatus(current));
    (managerA as any).cleanupOrphanSnat = vi.fn(async () => ({ deleted: [], unexpected: [] }));

    const cleanup = managerA.cleanupSandboxes({ now });
    await deletePending;
    await managerB.setActiveInvocationLease(name, 'inv-fast', new Date(now.getTime() + 60_000).toISOString());
    releaseDelete();
    const report = await cleanup;

    expect(deletePreconditions).toEqual({ uid: 'uid-delete', resourceVersion: 'rv-delete' });
    expect(report.deleted).toEqual([]);
    expect(report.skippedBusy).toEqual([name]);
    expect((current.raw.metadata.annotations as Record<string, string>)[
      activeInvocationLeaseAnnotationKey('inv-fast')
    ]).toBeDefined();
  });

  it('re-evaluates idle pause after a cross-instance lease wins the resourceVersion race', async () => {
    const now = new Date('2026-08-30T01:00:00.000Z');
    let current = sandboxStatus({ uid: 'uid-pause', resourceVersion: 'rv-pause', phase: 'Running' });
    let pauseStarted!: () => void;
    let releasePause!: () => void;
    const pausePending = new Promise<void>((resolve) => { pauseStarted = resolve; });
    const pauseBlocked = new Promise<void>((resolve) => { releasePause = resolve; });
    let pauseApplied = false;
    const run = vi.fn(async (args: string[]): Promise<KubectlResult> => {
      if (args[0] === 'patch' && args[2] === '--type=merge') {
        const payload = JSON.parse(args[4] ?? '{}') as { metadata?: { annotations?: Record<string, string> } };
        Object.assign(current.raw.metadata.annotations, payload.metadata?.annotations ?? {});
        current.raw.metadata.resourceVersion = 'rv-pause-leased';
        return ok();
      }
      if (args[0] === 'patch' && args[2] === '--type=json') {
        const expected = jsonPatchPreconditions(args);
        pauseStarted();
        await pauseBlocked;
        if (current.raw.metadata.uid !== expected.uid
          || current.raw.metadata.resourceVersion !== expected.resourceVersion) return conflict();
        pauseApplied = true;
        return ok();
      }
      return ok();
    });
    const config = {
      ...baseConfig(), lifecyclePolicyMode: 'shadow' as const, sandboxTtlMs: 24 * 60 * 60_000,
      sandboxIdlePauseMs: 30 * 60_000,
    };
    const managerA = new SandboxManager(config, { run } as unknown as Kubectl, noopLogger, new ActiveSandboxRegistry());
    const managerB = new SandboxManager(config, { run } as unknown as Kubectl, noopLogger, new ActiveSandboxRegistry());
    const name = managerA.ref(identity).name;
    vi.spyOn(managerA, 'listManagedSandboxes').mockResolvedValue([{
      name, phase: 'Running', createdAt: '2026-08-30T00:00:00.000Z', lastActiveAt: '2026-08-30T00:00:00.000Z',
      workloadClass: 'interactive', workloadDescriptor: { class: 'interactive' },
    }]);
    vi.spyOn(managerA, 'getStatus').mockImplementation(async () => cloneStatus(current));
    (managerA as any).cleanupOrphanSnat = vi.fn(async () => ({ deleted: [], unexpected: [] }));

    const cleanup = managerA.cleanupSandboxes({ now });
    await pausePending;
    await managerB.setActiveInvocationLease(name, 'inv-pause', new Date(Date.now() + 60_000).toISOString());
    releasePause();
    const report = await cleanup;

    expect(pauseApplied).toBe(false);
    expect(report.paused).toEqual([]);
    expect(report.skippedBusy).toEqual([name]);
  });
});
