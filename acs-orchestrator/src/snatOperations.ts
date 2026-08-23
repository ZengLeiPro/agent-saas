import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';

import type { SandboxManager } from './sandboxManager.js';

type SendJson = (res: ServerResponse, statusCode: number, body: unknown) => void;
type EmitAlert = (input: {
  event: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  metadata?: unknown;
}) => Promise<void>;

export interface SnatOperationsOptions {
  sandboxManager: SandboxManager;
  authorize: (req: IncomingMessage) => boolean;
  sendJson: SendJson;
  emitAlert: EmitAlert;
  logger: { warn(message: string): void };
  drainDeadlineMs: number;
  inflightRequests: () => number;
  lifecycleRunning: () => boolean;
  backgroundMutationRunning: () => boolean;
  stateFile?: string;
}

type RollbackState = 'idle' | 'restoring' | 'prepared';

export async function restorePerPodForNonPausedSandboxes(sandboxManager: SandboxManager) {
  const sandboxes = (await sandboxManager.listManagedSandboxes())
    .filter((sandbox) => sandbox.phase !== 'Paused')
    .map((sandbox) => {
      if (!sandbox.workspaceId || !sandbox.sandboxScopeId) {
        throw new Error(`Non-paused Sandbox 缺少 workspace/scope identity: ${sandbox.name}`);
      }
      return {
        name: sandbox.name,
        workspaceId: sandbox.workspaceId,
        sandboxScopeId: sandbox.sandboxScopeId,
      };
    });
  return await sandboxManager.snatManager.restorePerPodEntriesForManagedPods(sandboxes);
}

export class SnatOperations {
  private rollbackState: RollbackState;

  constructor(private readonly options: SnatOperationsOptions) {
    this.rollbackState = this.readRollbackState();
  }

  private readRollbackState(): RollbackState {
    if (!this.options.stateFile) return 'idle';
    try {
      const parsed = JSON.parse(readFileSync(this.options.stateFile, 'utf-8')) as { rollbackState?: unknown };
      if (['idle', 'restoring', 'prepared'].includes(String(parsed.rollbackState))) {
        return parsed.rollbackState as RollbackState;
      }
      throw new Error('invalid rollbackState');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'idle';
      throw new Error(`SNAT operation state unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private setRollbackState(state: RollbackState): void {
    if (this.options.stateFile) {
      mkdirSync(dirname(this.options.stateFile), { recursive: true });
      const tmp = `${this.options.stateFile}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ rollbackState: state })}\n`, 'utf-8');
      renameSync(tmp, this.options.stateFile);
    }
    this.rollbackState = state;
  }

  healthState(): { snatRollbackMaintenance: boolean; snatRollbackPrepared: boolean } {
    return {
      snatRollbackMaintenance: this.rollbackState !== 'idle',
      snatRollbackPrepared: this.rollbackState === 'prepared',
    };
  }

  isMaintenanceActive(): boolean {
    return this.rollbackState !== 'idle';
  }

  blocks(req: IncomingMessage): boolean {
    if (this.rollbackState === 'idle' || req.method === 'GET' || req.method === 'HEAD') return false;
    const path = (req.url ?? '').split(/[?#]/)[0] ?? '';
    if (path === '/snat/restore-per-pod' || path === '/snat/restore-per-pod/cancel') return false;
    return [
      '/warmup',
      '/provision',
      '/execute',
      '/execute-stream',
      '/lifecycle/cleanup',
      '/network-policy/probe',
      '/runtime-config',
      '/snat/cleanup-orphans',
      '/snat/migrate-shared',
    ].includes(path)
      || path.startsWith('/sandboxes/')
      || path.startsWith('/workspaces/');
  }

  async handleNetworkPolicyProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { authorize, sendJson, sandboxManager, logger } = this.options;
    if (req.method !== 'POST') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
    if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
    try {
      const result = await sandboxManager.probeNetworkPolicy();
      logger.warn(
        `network_policy_probe enforcement=${result.effectivePolicy.enforcement} `
        + `public=${result.effectivePolicy.publicEgressReachable} `
        + `privateBlocked=${result.effectivePolicy.privateEgressBlocked} `
        + `metadataBlocked=${result.effectivePolicy.metadataBlocked}`,
      );
      return sendJson(res, 200, { status: 'ok', networkPolicy: result });
    } catch (err) {
      return sendJson(res, 500, { status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { authorize, sendJson, sandboxManager } = this.options;
    if (req.method !== 'GET') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use GET' });
    if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
    try {
      return sendJson(res, 200, { status: 'ok', snat: await sandboxManager.snatStatus() });
    } catch (err) {
      return sendJson(res, 500, { status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async handleCleanup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { authorize, sendJson, sandboxManager, logger } = this.options;
    if (req.method !== 'POST') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
    if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
    try {
      const report = await sandboxManager.cleanupOrphanSnat();
      logger.warn(
        `snat_manual_cleanup checked=${report.checked} deleted=${report.deleted.length} `
        + `unexpected=${report.unexpected.length}`,
      );
      return sendJson(res, 200, { status: 'ok', report });
    } catch (err) {
      return sendJson(res, 500, { status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async freshSnatStatus() {
    const manager = this.options.sandboxManager.snatManager;
    return await manager.status(await manager.activeManagedPodCidrs());
  }

  async handleMigration(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { authorize, sendJson, sandboxManager, emitAlert } = this.options;
    if (req.method !== 'POST') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
    if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
    try {
      const snat = await this.freshSnatStatus();
      const verifiedDigest = req.headers['x-acs-snat-network-verified'];
      if (!snat.sharedCidrConfigDigest || verifiedDigest !== snat.sharedCidrConfigDigest) {
        return sendJson(res, 409, {
          status: 'error',
          error: 'real network verification must bind the current sharedCidrConfigDigest',
          expectedDigest: snat.sharedCidrConfigDigest,
        });
      }
      if (snat.uncoveredPodCidrs.length > 0) {
        return sendJson(res, 409, {
          status: 'error',
          error: `uncovered Pod CIDRs: ${snat.uncoveredPodCidrs.join(',')}`,
        });
      }
      const report = await sandboxManager.snatManager.migrateCoveredPerPodEntries();
      await emitAlert({
        event: 'snat_shared_cidr_migration',
        severity: report.deleted.length > 0 ? 'warning' : 'info',
        message: `ACS SNAT shared CIDR migration deleted ${report.deleted.length} covered /32 entries`,
        metadata: report,
      });
      return sendJson(res, 200, { status: 'ok', report });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await emitAlert({ event: 'snat_shared_cidr_migration_failed', severity: 'error', message });
      return sendJson(res, 500, { status: 'error', error: message });
    }
  }

  private rollbackMutationBusy(): boolean {
    return this.options.inflightRequests() > 1
      || this.options.lifecycleRunning()
      || this.options.backgroundMutationRunning();
  }

  async handleRestore(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { authorize, sendJson, sandboxManager, emitAlert } = this.options;
    if (req.method !== 'POST') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
    if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
    const alreadyPrepared = this.rollbackState === 'prepared';
    let keepMaintenance = this.rollbackState !== 'idle';
    try {
      const snat = await this.freshSnatStatus();
      const confirmedDigest = req.headers['x-acs-snat-rollback-confirmed'];
      if (!snat.sharedCidrConfigDigest || confirmedDigest !== snat.sharedCidrConfigDigest) {
        return sendJson(res, 409, {
          status: 'error',
          error: 'rollback confirmation must bind the current sharedCidrConfigDigest',
          expectedDigest: snat.sharedCidrConfigDigest,
        });
      }
      if (alreadyPrepared) {
        return sendJson(res, 200, { status: 'ok', rollbackPrepared: true, alreadyPrepared: true });
      }
      this.setRollbackState('restoring');
      const deadline = Date.now() + this.options.drainDeadlineMs;
      while (this.rollbackMutationBusy() && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      if (this.rollbackMutationBusy()) {
        throw new Error(
          `SNAT rollback maintenance quiesce timeout: inflight=${this.options.inflightRequests()} `
          + `lifecycle=${this.options.lifecycleRunning()} background=${this.options.backgroundMutationRunning()}`,
        );
      }
      const report = await restorePerPodForNonPausedSandboxes(sandboxManager);
      await emitAlert({
        event: 'snat_per_pod_restore',
        severity: 'warning',
        message: `ACS SNAT rollback restore confirmed ${report.available}/${report.checked} /32 entries Available`,
        metadata: report,
      });
      this.setRollbackState('prepared');
      keepMaintenance = true;
      return sendJson(res, 200, { status: 'ok', rollbackPrepared: true, report });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await emitAlert({ event: 'snat_per_pod_restore_failed', severity: 'error', message });
      return sendJson(res, 500, { status: 'error', error: message });
    } finally {
      if (!keepMaintenance && this.rollbackState !== 'idle') this.setRollbackState('idle');
    }
  }

  async handleRestoreCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { authorize, sendJson, sandboxManager, emitAlert } = this.options;
    if (req.method !== 'POST') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
    if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
    if (this.rollbackState !== 'prepared') {
      return sendJson(res, 409, { status: 'error', error: 'SNAT rollback is not prepared; cancellation is unavailable' });
    }
    const snat = await this.freshSnatStatus();
    if (!snat.sharedCidrConfigDigest
      || req.headers['x-acs-snat-rollback-confirmed'] !== snat.sharedCidrConfigDigest) {
      return sendJson(res, 409, {
        status: 'error',
        error: 'rollback cancellation must bind the current sharedCidrConfigDigest',
        expectedDigest: snat.sharedCidrConfigDigest,
      });
    }
    this.setRollbackState('idle');
    await emitAlert({
      event: 'snat_per_pod_restore_cancelled',
      severity: 'warning',
      message: 'ACS SNAT rollback maintenance was cancelled after /32 restore',
    });
    return sendJson(res, 200, { status: 'ok', rollbackPrepared: false });
  }
}
