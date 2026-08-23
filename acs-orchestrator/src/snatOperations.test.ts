import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SandboxManager } from './sandboxManager.js';
import { SnatOperations } from './snatOperations.js';

function request(path: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method: 'POST', url: path, headers } as IncomingMessage;
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(
  stateFile?: string,
  emitAlert: (input: any) => Promise<void> = vi.fn(async () => undefined),
) {
  const responses: Array<{ statusCode: number; body: unknown }> = [];
  const restore = vi.fn(async () => ({ checked: 1, available: 1, entries: [] }));
  const migrate = vi.fn(async () => ({ enabled: true, checked: 1, deleted: [], orphanCidrs: [], unexpected: [] }));
  const sandboxManager = {
    snatStatus: vi.fn(async () => ({
      sharedCidrConfigDigest: 'digest-1',
      uncoveredPodCidrs: [],
    })),
    listManagedSandboxes: vi.fn(async () => [
      { name: 'as-running', phase: 'Running', workspaceId: 'workspace-1', sandboxScopeId: 'scope-1' },
      { name: 'as-paused', phase: 'Paused', workspaceId: 'workspace-2', sandboxScopeId: 'scope-2' },
      { name: 'as-pending', phase: 'Pending', workspaceId: 'workspace-3', sandboxScopeId: 'scope-3' },
    ]),
    snatManager: {
      activeManagedPodCidrs: vi.fn(async () => new Set<string>()),
      status: vi.fn(async () => ({ sharedCidrConfigDigest: 'digest-1', uncoveredPodCidrs: [] })),
      restorePerPodEntriesForManagedPods: restore,
      migrateCoveredPerPodEntries: migrate,
    },
  } as unknown as SandboxManager;
  const operations = new SnatOperations({
    sandboxManager,
    authorize: () => true,
    sendJson: (_res, statusCode, body) => { responses.push({ statusCode, body }); },
    emitAlert,
    logger: { warn: vi.fn() },
    drainDeadlineMs: 1_000,
    inflightRequests: () => 1,
    lifecycleRunning: () => false,
    backgroundMutationRunning: () => false,
    ...(stateFile ? { stateFile } : {}),
  });
  return { operations, responses, restore, migrate };
}

describe('SnatOperations rollback maintenance', () => {
  it('freezes mutations and restores only the stable Running Sandbox set until cancellation', async () => {
    const { operations, responses, restore } = setup();

    await operations.handleRestore(
      request('/snat/restore-per-pod', { 'x-acs-snat-rollback-confirmed': 'digest-1' }),
      {} as ServerResponse,
    );

    expect(responses.at(-1)).toMatchObject({ statusCode: 200, body: { rollbackPrepared: true } });
    expect(restore).toHaveBeenCalledWith([
      { name: 'as-running', workspaceId: 'workspace-1', sandboxScopeId: 'scope-1' },
      { name: 'as-pending', workspaceId: 'workspace-3', sandboxScopeId: 'scope-3' },
    ]);
    expect(operations.healthState()).toEqual({
      snatRollbackMaintenance: true,
      snatRollbackPrepared: true,
    });
    expect(operations.blocks(request('/provision'))).toBe(true);
    expect(operations.blocks({ method: 'GET', url: '/health' } as IncomingMessage)).toBe(false);

    await operations.handleRestoreCancel(
      request('/snat/restore-per-pod/cancel', { 'x-acs-snat-rollback-confirmed': 'digest-1' }),
      {} as ServerResponse,
    );
    expect(operations.healthState()).toEqual({
      snatRollbackMaintenance: false,
      snatRollbackPrepared: false,
    });
  });

  it('keeps prepared maintenance active across process reconstruction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'snat-operation-state-'));
    cleanupDirs.push(dir);
    const stateFile = join(dir, 'state.json');
    const first = setup(stateFile);
    await first.operations.handleRestore(
      request('/snat/restore-per-pod', { 'x-acs-snat-rollback-confirmed': 'digest-1' }),
      {} as ServerResponse,
    );

    const reconstructed = setup(stateFile);
    expect(reconstructed.operations.healthState()).toEqual({
      snatRollbackMaintenance: true,
      snatRollbackPrepared: true,
    });
    expect(reconstructed.operations.blocks(request('/provision'))).toBe(true);
    await reconstructed.operations.handleRestore(
      request('/snat/restore-per-pod', { 'x-acs-snat-rollback-confirmed': 'digest-1' }),
      {} as ServerResponse,
    );
    expect(reconstructed.responses.at(-1)).toMatchObject({
      statusCode: 200,
      body: { rollbackPrepared: true, alreadyPrepared: true },
    });
    expect(reconstructed.restore).not.toHaveBeenCalled();
  });

  it('rejects cancellation while the restore alert is still pending', async () => {
    let releaseAlert!: () => void;
    let markAlertStarted!: () => void;
    const alertStarted = new Promise<void>((resolve) => { markAlertStarted = resolve; });
    const alertGate = new Promise<void>((resolve) => { releaseAlert = resolve; });
    const { operations, responses } = setup(undefined, async (input) => {
      if (input.event === 'snat_per_pod_restore') {
        markAlertStarted();
        await alertGate;
      }
    });
    const restoring = operations.handleRestore(
      request('/snat/restore-per-pod', { 'x-acs-snat-rollback-confirmed': 'digest-1' }),
      {} as ServerResponse,
    );
    await alertStarted;
    await operations.handleRestoreCancel(
      request('/snat/restore-per-pod/cancel', { 'x-acs-snat-rollback-confirmed': 'digest-1' }),
      {} as ServerResponse,
    );
    expect(responses.at(-1)?.statusCode).toBe(409);
    releaseAlert();
    await restoring;
  });

  it('keeps a crash-interrupted restoring state fail-closed when retry confirmation is stale', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'snat-operation-state-'));
    cleanupDirs.push(dir);
    const stateFile = join(dir, 'state.json');
    writeFileSync(stateFile, JSON.stringify({ rollbackState: 'restoring' }));
    const { operations } = setup(stateFile);

    await operations.handleRestore(
      request('/snat/restore-per-pod', { 'x-acs-snat-rollback-confirmed': 'stale' }),
      {} as ServerResponse,
    );
    expect(operations.healthState().snatRollbackMaintenance).toBe(true);
    expect(operations.blocks(request('/provision'))).toBe(true);
  });

  it('releases maintenance when the rollback digest is stale', async () => {
    const { operations, responses, restore } = setup();

    await operations.handleRestore(
      request('/snat/restore-per-pod', { 'x-acs-snat-rollback-confirmed': 'stale' }),
      {} as ServerResponse,
    );

    expect(responses.at(-1)?.statusCode).toBe(409);
    expect(restore).not.toHaveBeenCalled();
    expect(operations.healthState().snatRollbackMaintenance).toBe(false);
  });
});
