import type { AcsLogger, AlertDispatcher } from './alerts.js';
import type { AcsOrchestratorConfig } from './config.js';
import type { AcsExecutor } from './executor.js';
import type { Provisioner } from './provision.js';
import type { SandboxManager } from './sandboxManager.js';

export class SandboxLifecycleController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lifecycleRunning = false;
  private staleImagePrewarmRunning = false;

  constructor(
    private readonly config: AcsOrchestratorConfig,
    private readonly provisioner: Provisioner,
    private readonly executor: AcsExecutor,
    private readonly sandboxManager: SandboxManager,
    private readonly alerts: AlertDispatcher,
    private readonly logger: AcsLogger,
    private readonly activeBusySandboxNames: () => Set<string>,
    private readonly maintenanceActive: () => boolean,
  ) {}

  isLifecycleRunning(): boolean {
    return this.lifecycleRunning;
  }

  isBackgroundMutationRunning(): boolean {
    return this.staleImagePrewarmRunning;
  }

  start(): void {
    if (!this.config.lifecycleEnabled) {
      this.logger.info('sandbox lifecycle loop disabled');
      return;
    }
    void this.runStaleImagePrewarmOnce('startup');
    void this.runLifecycleOnce('startup');
    this.timer = setInterval(() => {
      void this.runStaleImagePrewarmOnce('interval');
      void this.runLifecycleOnce('interval');
    }, this.config.sandboxCleanupIntervalMs);
    this.timer.unref?.();
    this.logger.info(
      `sandbox lifecycle loop enabled intervalMs=${this.config.sandboxCleanupIntervalMs}`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runStaleImagePrewarmOnce(reason: string): Promise<void> {
    if (this.maintenanceActive()) {
      this.logger.info(
        `sandbox_stale_image_prewarm reason=${reason} skipped=snat_rollback_maintenance`,
      );
      return;
    }
    if (this.staleImagePrewarmRunning) {
      this.logger.info(`sandbox_stale_image_prewarm reason=${reason} skipped=already_running`);
      return;
    }
    this.staleImagePrewarmRunning = true;
    try {
      const result = await this.provisioner.prewarmStaleImagePausedSandboxes({
        busySandboxNames: this.activeBusySandboxNames(),
      });
      if (
        result.queued.length ||
        result.skipped.length ||
        result.skippedBusy.length ||
        result.failed.length
      ) {
        this.logger.warn(
          `sandbox_stale_image_prewarm reason=${reason} queued=${result.queued.length} ` +
            `retired=${result.retired.length} adopted=${result.adopted.length} ` +
            `skipped=${result.skipped.length} skippedBusy=${result.skippedBusy.length} failed=${result.failed.length}`,
        );
        await this.alerts.emit({
          event: 'sandbox_stale_image_prewarm',
          severity: result.failed.length ? 'warning' : 'info',
          message: `ACS Sandbox stale-image retire processed ${result.queued.length} Paused sandbox${result.queued.length === 1 ? '' : 'es'}`,
          metadata: result,
        });
      } else {
        this.logger.info(
          `sandbox_stale_image_prewarm reason=${reason} queued=0 skipped=0 failed=0`,
        );
      }
    } catch (error) {
      this.logger.error(
        `sandbox_stale_image_prewarm_error reason=${reason} err=${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.staleImagePrewarmRunning = false;
    }
  }

  private async runLifecycleOnce(reason: string): Promise<void> {
    if (this.maintenanceActive()) {
      this.logger.info(`sandbox_lifecycle reason=${reason} skipped=snat_rollback_maintenance`);
      return;
    }
    if (this.lifecycleRunning) {
      this.logger.info(`sandbox_lifecycle reason=${reason} skipped=already_running`);
      return;
    }
    this.lifecycleRunning = true;
    try {
      const backgroundShells = await this.executor.reconcileBackgroundShellProtections();
      if (backgroundShells.checked > 0) {
        this.logger.info(
          `background_shell_reconcile reason=${reason} checked=${backgroundShells.checked} failed=${backgroundShells.failed}`,
        );
      }
      const report = await this.sandboxManager.cleanupSandboxes({
        busySandboxNames: this.activeBusySandboxNames(),
      });
      if (
        report.paused.length ||
        report.deleted.length ||
        report.brokenRecycled.length ||
        report.skippedBusy.length
      ) {
        this.logger.warn(
          `sandbox_lifecycle_actions reason=${reason} checked=${report.checked} paused=${report.paused.length} ` +
            `deleted=${report.deleted.length} brokenRecycled=${report.brokenRecycled.length} ` +
            `skippedBusy=${report.skippedBusy.length} snatDeleted=${report.snatDeleted.length}`,
        );
        await this.alerts.emit({
          event: 'sandbox_lifecycle_actions',
          severity: report.deleted.length || report.brokenRecycled.length ? 'warning' : 'info',
          message: report.brokenRecycled.length
            ? `ACS Sandbox lifecycle recycled ${report.brokenRecycled.length} broken paused sandbox${report.brokenRecycled.length === 1 ? '' : 'es'} (false-paused billing leak)`
            : 'ACS Sandbox lifecycle guard took action',
          metadata: report,
        });
      }
      if (report.snatDeleted.length || report.snatUnexpected > 0) {
        await this.alerts.emit({
          event: report.snatUnexpected > 0 ? 'snat_unexpected_entries' : 'snat_orphan_cleanup',
          severity: report.snatUnexpected > 0 ? 'warning' : 'info',
          message:
            report.snatUnexpected > 0
              ? `ACS SNAT table has ${report.snatUnexpected} unexpected entry${report.snatUnexpected === 1 ? '' : 'ies'}`
              : `ACS SNAT orphan cleanup deleted ${report.snatDeleted.length} entr${report.snatDeleted.length === 1 ? 'y' : 'ies'}`,
          metadata: {
            snatDeleted: report.snatDeleted,
            snatUnexpected: report.snatUnexpected,
          },
        });
      }
      const inventory = await this.sandboxManager.inventorySummary();
      const nearCount =
        this.config.warnRunningSandboxes > 0 &&
        inventory.allocatedCount >= this.config.warnRunningSandboxes;
      const nearCpu =
        this.config.warnAllocatedCpuMillicores > 0 &&
        inventory.allocatedCpuMillicores >= this.config.warnAllocatedCpuMillicores;
      const nearMemory =
        this.config.warnAllocatedMemoryMib > 0 &&
        inventory.allocatedMemoryBytes >= this.config.warnAllocatedMemoryMib * 1024 * 1024;
      if (nearCount || nearCpu || nearMemory) {
        await this.alerts.emit({
          event: 'sandbox_allocated_near_quota',
          severity: inventory.executionReady ? 'warning' : 'error',
          message: `ACS allocated capacity count=${inventory.allocatedCount} cpu=${inventory.allocatedCpuMillicores}m`,
          metadata: inventory,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`sandbox_lifecycle_failed reason=${reason}: ${message}`);
      await this.alerts.emit({
        event: 'sandbox_lifecycle_failed',
        severity: 'error',
        message,
        metadata: { reason },
      });
    } finally {
      this.lifecycleRunning = false;
    }
  }
}
