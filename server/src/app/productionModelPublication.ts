import type { GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assertPublishedDisk,
  atomicWrite,
  canonical,
  isOwnerAlive,
  processIdentity,
  publishedExpected,
  readPublication,
} from '../../../scripts/release/config-publication.mjs';
import { AdminConfigMutationService } from '../config/adminConfigMutationService.js';
import {
  ProductionModelPublisher,
  type PublicationReceipt,
  type PublicationTarget,
} from '../config/productionModelPublisher.js';
import {
  computeObservedConfigIdentity,
  evaluateConfigIdentityStatus,
} from '../release/configIdentity.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import type { SecretVault } from '../security/secretVault.js';
import { getAppConfigPath, type AppConfig } from './config.js';
import type { SharedConfigRefresher } from './sharedConfigRefresher.js';
import type { RuntimeConfigIdentityAssembly } from './configIdentityAssembly.js';

function activeTargets(configPath: string): PublicationTarget[] {
  const root = dirname(configPath);
  return (['ws-only', 'runtime-worker'] as const).map((role) => {
    const worker = role === 'runtime-worker';
    const color = readFileSync(
      join(root, worker ? 'runtime-worker-active-color' : 'active-color'),
      'utf8',
    ).trim();
    if (color !== 'blue' && color !== 'green') throw new Error('活动配置拓扑无效');
    const prefix = worker ? 'agent-saas-runtime-worker' : 'agent-saas-server';
    if (existsSync(`/run/${prefix}-${color}.draining`)) throw new Error('目标进程正在排空');
    const pid = Number(readFileSync(`/run/${prefix}-${color}.pid`, 'utf8').trim());
    const mainPid = Number(
      execFileSync(
        'systemctl',
        ['show', `${prefix}@${color}.service`, '--property=MainPID', '--value'],
        { encoding: 'utf8', timeout: 2_000 },
      ).trim(),
    );
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid !== mainPid)
      throw new Error('配置目标进程与 systemd MainPID 不一致');
    return {
      role,
      process: processIdentity(pid),
      receiptPath: `/run/${prefix}-${color}.config-identity.json.applied`,
    };
  });
}

/** Called only after the execution-side model and memory services have been assembled. */
export function initializeProductionModelPublication(options: {
  config: AppConfig;
  processCwd: string;
  processRole: string;
  secretVault: SecretVault;
  grokCredentialManager?: GrokCredentialManager;
  refresher: SharedConfigRefresher;
  identity: RuntimeConfigIdentityAssembly;
  logger: { warn(message: string): void };
}) {
  const runtime = readRuntimeIdentity();
  const snapshotPath = process.env.AGENT_SAAS_CONFIG_IDENTITY_PATH?.trim();
  if (
    runtime.environment !== 'production' ||
    !runtime.releaseId ||
    !runtime.expectedConfigIdentity ||
    !snapshotPath ||
    !['ws-only', 'runtime-worker'].includes(options.processRole)
  )
    return undefined;
  const configPath = getAppConfigPath(options.processCwd);
  const releaseId = runtime.releaseId;
  const expected = runtime.expectedConfigIdentity;
  const receiptPath = `${snapshotPath}.applied`;
  const role = options.processRole as PublicationTarget['role'];
  const self = processIdentity();
  let stopped = false;
  let pending: Promise<void> | undefined;
  let lastWarning = 0;
  let recovering = false;
  const removeReceipt = () => {
    try {
      rmSync(receiptPath, { force: true });
    } catch {
      /* Absence fails closed. */
    }
  };
  const observe = (): Promise<void> => {
    if (pending) return pending;
    pending = (async () => {
      if (
        stopped ||
        (process.env.AGENT_SAAS_DRAIN_MARKER && existsSync(process.env.AGENT_SAAS_DRAIN_MARKER))
      ) {
        removeReceipt();
        return;
      }
      const before = assertPublishedDisk(configPath);
      if (!before) {
        removeReceipt();
        return;
      }
      // This is the application path. The public execution wrapper separately
      // blocks NEW work during applying/rollback, but must not block this observer.
      if (
        !(await options.refresher.refreshIfChanged(true)) ||
        options.refresher.getAppliedStamps().config?.digest !== before.rawRevision
      ) {
        removeReceipt();
        return;
      }
      const observed = await computeObservedConfigIdentity(
        options.config,
        options.secretVault,
        options.processCwd,
      );
      const selected = publishedExpected(configPath, releaseId, expected, false);
      if (evaluateConfigIdentityStatus(selected, observed).status !== 'consistent') {
        removeReceipt();
        return;
      }
      await options.identity.refreshSummary();
      const after = assertPublishedDisk(configPath);
      if (
        stopped ||
        canonical(after) !== canonical(before) ||
        options.refresher.getAppliedStamps().config?.digest !== before.rawRevision
      ) {
        removeReceipt();
        return;
      }
      const receipt: PublicationReceipt = {
        schemaVersion: 1,
        releaseId,
        role,
        process: self,
        revision: before.revision,
        sequence: before.sequence,
        phase: before.phase,
        rawRevision: before.rawRevision,
        identity: {
          schemaVersion: 1,
          digest: observed.digest,
          ...(observed.credentialVersionDigest
            ? { credentialVersionDigest: observed.credentialVersionDigest }
            : {}),
        },
        recordedAt: Date.now(),
      };
      atomicWrite(receiptPath, `${JSON.stringify(receipt)}\n`);
    })()
      .catch((error: unknown) => {
        removeReceipt();
        if (Date.now() - lastWarning >= 5_000) {
          lastWarning = Date.now();
          options.logger.warn(
            `Production config readback unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  const publisher = new ProductionModelPublisher({
          configPath,
          processCwd: options.processCwd,
          releaseId,
          expected,
          secretVault: options.secretVault,
          targets: () => activeTargets(configPath),
          observeLocal: observe,
          pendingCredentialRotations: () => options.grokCredentialManager?.getPendingPublicationRefs() ?? Promise.resolve([]),
          acknowledgeCredentialRotation: (ref) => options.grokCredentialManager?.acknowledgeCredentialRotation(ref) ?? Promise.resolve(),
        });
  const mutationService = publisher
    && role === 'ws-only' ? new AdminConfigMutationService({
        configPath,
        processCwd: options.processCwd,
        environment: 'production',
        processRole: role,
        productionPublisher: publisher,
      })
    : undefined;
  const tick = async () => {
    await observe();
    if (stopped || recovering || !mutationService) return;
    try {
      const state = readPublication(configPath);
      const hasPendingRotation = (await options.grokCredentialManager?.getPendingPublicationRefs() ?? []).length > 0;
      if (
        !state ||
        (state.phase === 'committed' && !hasPendingRotation) ||
        (state.phase !== 'committed' && state.phase !== 'recovery_required' && state.owner && isOwnerAlive(state.owner))
      )
        return;
      if (
        !activeTargets(configPath).some(
          (target) => target.role === role && target.process.pid === process.pid,
        )
      )
        return;
      recovering = true;
      await mutationService.recoverProductionPublication();
    } catch {
      /* Lock held by deploy/save or incomplete peers: keep the signed gate closed and retry. */
    } finally {
      recovering = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 500);
  timer.unref();
  void tick();
  return {
    mutationService,
    coordinateCredentialRotation: (credentialRef: string) => publisher.coordinateCredentialRotation(credentialRef),
    withCredentialRotation: <T>(ref: string, rotate: () => Promise<T>) => publisher.withCredentialRotation(ref, rotate),
    observe,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      removeReceipt();
    },
  };
}
