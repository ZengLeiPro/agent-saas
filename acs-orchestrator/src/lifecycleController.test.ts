import { describe, expect, it, vi } from 'vitest';
import type { AlertDispatcher } from './alerts.js';
import type { AcsOrchestratorConfig } from './config.js';
import type { AcsExecutor } from './executor.js';
import { SandboxLifecycleController } from './lifecycleController.js';
import type { Provisioner } from './provision.js';
import type { SandboxManager } from './sandboxManager.js';

describe('SandboxLifecycleController', () => {
  it('keeps disabled lifecycle inert', () => {
    const info = vi.fn();
    const controller = new SandboxLifecycleController(
      { lifecycleEnabled: false } as AcsOrchestratorConfig,
      {} as Provisioner,
      {} as AcsExecutor,
      {} as SandboxManager,
      {} as AlertDispatcher,
      { info, warn: vi.fn(), error: vi.fn() },
      () => new Set(),
      () => false,
    );
    controller.start();
    expect(info).toHaveBeenCalledWith('sandbox lifecycle loop disabled');
    expect(controller.isLifecycleRunning()).toBe(false);
  });

  it('runs startup prewarm and cleanup while exposing bounded mutation state', async () => {
    const prewarm = vi.fn().mockResolvedValue({
      queued: [],
      retired: [],
      adopted: [],
      skipped: [],
      skippedBusy: [],
      failed: [],
    });
    const reconcile = vi.fn().mockResolvedValue({ checked: 0, failed: 0 });
    const cleanup = vi.fn().mockResolvedValue({
      checked: 0,
      paused: [],
      deleted: [],
      brokenRecycled: [],
      skippedBusy: [],
      snatDeleted: [],
      snatUnexpected: 0,
    });
    const inventory = vi.fn().mockResolvedValue({
      allocatedCount: 0,
      allocatedCpuMillicores: 0,
      allocatedMemoryBytes: 0,
      executionReady: true,
    });
    const controller = new SandboxLifecycleController(
      {
        lifecycleEnabled: true,
        sandboxCleanupIntervalMs: 60_000,
        warnRunningSandboxes: 1,
        warnAllocatedCpuMillicores: 1,
        warnAllocatedMemoryMib: 1,
      } as AcsOrchestratorConfig,
      { prewarmStaleImagePausedSandboxes: prewarm } as unknown as Provisioner,
      { reconcileBackgroundShellProtections: reconcile } as unknown as AcsExecutor,
      { cleanupSandboxes: cleanup, inventorySummary: inventory } as unknown as SandboxManager,
      { emit: vi.fn() } as unknown as AlertDispatcher,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      () => new Set(),
      () => false,
    );

    controller.start();
    await vi.waitFor(() => expect(inventory).toHaveBeenCalledTimes(1));
    controller.stop();
    expect(prewarm).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(controller.isLifecycleRunning()).toBe(false);
    expect(controller.isBackgroundMutationRunning()).toBe(false);
  });
});
