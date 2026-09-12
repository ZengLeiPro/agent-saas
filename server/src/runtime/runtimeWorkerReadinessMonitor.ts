import type { ConfigIdentitySummary } from '@agent/shared';
import { readRuntimeIdentity, type RuntimeIdentity } from '../release/runtimeIdentity.js';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { RuntimeAdmissionSnapshot } from './memoryPressureGuard.js';
import {
  projectRuntimeWorkerReadyFile,
  removeRuntimeWorkerReadyFiles,
} from './runtimeWorkerReadiness.js';

const ADMISSION_REASONS = new Set([
  'host_mem_available_low',
  'host_mem_available_critical',
  'worker_cgroup_near_high',
  'memory_psi_full',
  'memory_psi_some',
  'runtime_event_retention_status_unavailable',
  'runtime_worker_not_ready',
]);
const NUMERIC_FIELDS = [
  'totalBytes',
  'availableBytes',
  'psiSomeAvg10',
  'psiFullAvg10',
  'cgroupCurrentBytes',
  'cgroupHighBytes',
  'cgroupMaxBytes',
  'cgroupWorkingSetBytes',
  'cgroupSlabReclaimableBytes',
  'enterAvailableBytes',
  'resumeAvailableBytes',
] as const;
const CONFIG_STATUSES = new Set(['consistent', 'drifted', 'unverifiable', 'not_collected']);

export interface WorkerDiagnosticIdentity {
  pid: number;
  bootId?: string;
  processStartTicks?: string;
  environment?: string;
  releaseId?: string;
  releaseSha?: string;
  serverDigest?: string;
}

function processIdentity(): WorkerDiagnosticIdentity {
  let bootId: string | undefined;
  let processStartTicks: string | undefined;
  try {
    bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = readFileSync('/proc/self/stat', 'utf8');
    processStartTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    /* Non-Linux diagnostics remain explicitly unbound. */
  }
  let release: Partial<RuntimeIdentity> = {};
  try {
    release = readRuntimeIdentity();
  } catch {
    /* Diagnostic identity stays unbound. */
  }
  return {
    pid: process.pid,
    bootId,
    processStartTicks,
    environment: release.environment,
    releaseId: release.releaseId,
    releaseSha: release.releaseSha,
    serverDigest: release.serverDigest,
  };
}

export function safeWorkerDiagnosticIdentity(identity: WorkerDiagnosticIdentity) {
  return {
    pid: Number.isSafeInteger(identity.pid) && identity.pid > 0 ? identity.pid : null,
    bootId: /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(identity.bootId ?? '')
      ? identity.bootId
      : null,
    processStartTicks: /^[0-9]{1,24}$/u.test(identity.processStartTicks ?? '')
      ? identity.processStartTicks
      : null,
    environment: ['production', 'staging', 'test', 'development'].includes(
      identity.environment ?? '',
    )
      ? identity.environment
      : null,
    releaseId: /^rc-[0-9]{8}-[0-9]{2,}$/u.test(identity.releaseId ?? '')
      ? identity.releaseId
      : null,
    releaseSha: /^[a-f0-9]{40}$/u.test(identity.releaseSha ?? '') ? identity.releaseSha : null,
    serverDigest: /^sha256:[a-f0-9]{64}$/u.test(identity.serverDigest ?? '')
      ? identity.serverDigest
      : null,
  };
}

export function safeAdmissionDiagnostic(snapshot: RuntimeAdmissionSnapshot | undefined) {
  if (!snapshot) return { state: 'unknown', admitting: false, reason: 'unavailable' };
  return {
    state: ['unknown', 'healthy', 'paused'].includes(snapshot.state) ? snapshot.state : 'unknown',
    admitting: snapshot.admitting === true,
    reason: snapshot.reason
      ? ADMISSION_REASONS.has(snapshot.reason)
        ? snapshot.reason
        : 'unclassified'
      : null,
    ...Object.fromEntries(
      NUMERIC_FIELDS.flatMap((field) => {
        const value = snapshot[field];
        return typeof value === 'number' && Number.isFinite(value) && value >= 0
          ? [[field, value]]
          : [];
      }),
    ),
  };
}

export interface WorkerReadinessMonitorOptions {
  readyFile: string;
  refreshConfigIdentity: () => Promise<ConfigIdentitySummary | undefined>;
  getConfigIdentity: () => ConfigIdentitySummary | undefined;
  getRefreshFailure?: () => 'config_refresh_timeout' | 'config_refresh_failed' | undefined;
  getAdmission: () => RuntimeAdmissionSnapshot | undefined;
  privateSnapshotCurrent: () => boolean;
  logger: { warn(message: string): void };
  identity?: WorkerDiagnosticIdentity;
  now?: () => number;
}

/** Owns the existing one-second projection; status.json is diagnostic, never an admission token. */
export function createRuntimeWorkerReadinessMonitor(options: WorkerReadinessMonitorOptions) {
  const now = options.now ?? Date.now;
  const identity = safeWorkerDiagnosticIdentity(options.identity ?? processIdentity());
  const statusPath = `${options.readyFile}.status.json`;
  let pending = false;
  let stopped = false;
  let startedAt = 0;
  let slow = false;
  let sequence = 0;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  function publish(state: string, summary?: ConfigIdentitySummary) {
    const temp = `${statusPath}.${process.pid}.${++sequence}.tmp`;
    try {
      const currentSummary = summary ?? options.getConfigIdentity();
      const admission = safeAdmissionDiagnostic(options.getAdmission());
      const privateSnapshotCurrent = options.privateSnapshotCurrent();
      const body = {
        schemaVersion: 1,
        ...identity,
        sampledAt: new Date(now()).toISOString(),
        state,
        configStatus: CONFIG_STATUSES.has(currentSummary?.status ?? '')
          ? currentSummary?.status
          : 'unavailable',
        privateSnapshotCurrent,
        admission,
        refresh: {
          pending,
          slow,
          startedAt: startedAt ? new Date(startedAt).toISOString() : null,
          durationMs: startedAt ? Math.max(0, now() - startedAt) : 0,
        },
      };
      writeFileSync(temp, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temp, statusPath);
    } catch {
      try {
        rmSync(temp, { force: true });
        rmSync(statusPath, { force: true });
      } catch {
        /* Diagnostic only. */
      }
      options.logger.warn('Runtime Worker readiness diagnostic publication failed');
    }
  }

  function withdraw() {
    try {
      removeRuntimeWorkerReadyFiles(options.readyFile);
    } catch {
      options.logger.warn('Runtime Worker readyfile withdrawal failed');
    }
  }

  function completedState(summary: ConfigIdentitySummary | undefined) {
    const failure = options.getRefreshFailure?.();
    if (failure) return failure;
    if (summary?.status !== 'consistent')
      return `config_${CONFIG_STATUSES.has(summary?.status ?? '') ? summary?.status : 'unavailable'}`;
    if (!options.privateSnapshotCurrent()) return 'private_snapshot_unavailable';
    if (options.getAdmission()?.admitting !== true) return 'admission_paused';
    return 'ready';
  }

  async function sync() {
    if (stopped) return;
    if (pending) {
      publish(slow ? 'config_refresh_slow' : 'config_refresh_pending');
      return;
    }
    pending = true;
    startedAt = now();
    slow = false;
    publish('config_refresh_pending');
    watchdog = setTimeout(() => {
      if (stopped) return;
      slow = true;
      withdraw();
      publish('config_refresh_slow');
    }, 1_000);
    watchdog.unref?.();
    try {
      // ConfigIdentityRuntime bounds the COMPLETE observation, not just each Vault request.
      const summary = await options.refreshConfigIdentity();
      if (stopped) return; // A late result must not revive a drained generation.
      projectRuntimeWorkerReadyFile(
        options.readyFile,
        options.getAdmission(),
        summary,
        options.privateSnapshotCurrent(),
        identity.pid ?? process.pid,
      );
      pending = false;
      publish(completedState(summary), summary);
    } catch {
      if (!stopped) {
        withdraw();
        pending = false;
        publish('projection_failed');
      }
      options.logger.warn('Runtime Worker readiness projection failed');
    } finally {
      if (watchdog) clearTimeout(watchdog);
      watchdog = undefined;
      pending = false;
    }
  }

  function stop() {
    stopped = true;
    if (watchdog) clearTimeout(watchdog);
    withdraw();
    publish('draining');
  }
  return { sync, stop };
}
