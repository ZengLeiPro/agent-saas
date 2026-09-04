import type { ConfigIdentitySummary } from '@agent/shared';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { RuntimeAdmissionGuard, RuntimeAdmissionSnapshot } from './memoryPressureGuard.js';

const ACTIVE_COLOR_FILE = '/etc/agent-saas/runtime-worker-active-color';
const ORG_AGENT_PROTOCOL_MARKER = 'org-group-agent-background-v2';

interface OrgAgentProtocolMarker {
  pid: number;
  protocolVersion: 2;
  readyFileMtimeNs: string;
  releaseSha?: string;
}

export interface RuntimeWorkerReadinessOptions {
  activeColorFile?: string;
  activeReadyFile?: string;
  readyFileForColor?: (color: 'blue' | 'green') => string;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
}

// runtime-worker 的 readyfile 同时代表显式开放准入、ConfigIdentity 一致性与必要
// singleton worker 已建立权威状态。任一证据缺失或撤销时都必须 fail closed。
export function projectRuntimeWorkerReadyFile(
  readyFile: string,
  snapshot: RuntimeAdmissionSnapshot | undefined,
  configIdentity: ConfigIdentitySummary | undefined,
  privateSnapshotCurrent: boolean,
  pid = process.pid,
): void {
  if (
    snapshot?.admitting !== true
    || configIdentity?.status !== 'consistent'
    || !privateSnapshotCurrent
  ) {
    removeRuntimeWorkerReadyFiles(readyFile);
    return;
  }
  const expected = `${pid}\n`;
  let current = false;
  try {
    current = readFileSync(readyFile, 'utf8') === expected;
  } catch {
    /* 首次发布或外部清理后重建 */
  }
  if (!current) writeFileSync(readyFile, expected, 'utf8');
  const marker: OrgAgentProtocolMarker = {
    pid,
    protocolVersion: 2,
    readyFileMtimeNs: statSync(readyFile, { bigint: true }).mtimeNs.toString(),
    ...(process.env.AGENT_SAAS_RELEASE_SHA
      ? { releaseSha: process.env.AGENT_SAAS_RELEASE_SHA }
      : {}),
  };
  writeFileSync(`${readyFile}.${ORG_AGENT_PROTOCOL_MARKER}`, `${JSON.stringify(marker)}\n`, 'utf8');
}

export function removeRuntimeWorkerReadyFiles(readyFile: string): void {
  rmSync(readyFile, { force: true });
  rmSync(`${readyFile}.${ORG_AGENT_PROTOCOL_MARKER}`, { force: true });
}

export function isActiveRuntimeWorkerOrgAgentV2Ready(
  options: RuntimeWorkerReadinessOptions = {},
): boolean {
  try {
    const { pid, readyFile } = readActiveWorkerIdentity(options);
    const marker = JSON.parse(
      readFileSync(`${readyFile}.${ORG_AGENT_PROTOCOL_MARKER}`, 'utf8'),
    ) as Partial<OrgAgentProtocolMarker>;
    return marker.pid === pid
      && marker.protocolVersion === 2
      && marker.readyFileMtimeNs === statSync(readyFile, { bigint: true }).mtimeNs.toString()
      && (marker.releaseSha === undefined || /^[a-f0-9]{40}$/u.test(marker.releaseSha));
  } catch {
    return false;
  }
}

export function readActiveRuntimeWorkerAdmissionSnapshot(
  options: RuntimeWorkerReadinessOptions = {},
): RuntimeAdmissionSnapshot {
  const sampledAt = new Date((options.now ?? Date.now)()).toISOString();
  try {
    readActiveWorkerIdentity(options);
    return { state: 'healthy', admitting: true, sampledAt };
  } catch {
    return unavailableSnapshot(sampledAt);
  }
}

function readActiveWorkerIdentity(
  options: RuntimeWorkerReadinessOptions,
): { pid: number; readyFile: string } {
  let readyFile = options.activeReadyFile ?? process.env.AGENT_SAAS_ACTIVE_RUNTIME_WORKER_READYFILE;
  if (!readyFile) {
    const color = readFileSync(options.activeColorFile ?? ACTIVE_COLOR_FILE, 'utf8').trim();
    if (color !== 'blue' && color !== 'green') throw new Error('runtime worker color unavailable');
    readyFile = options.readyFileForColor?.(color) ?? `/run/agent-saas-runtime-worker-${color}.ready`;
  }
  const pid = Number(readFileSync(readyFile, 'utf8').trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('runtime worker pid unavailable');
  const isProcessAlive = options.isProcessAlive ?? ((candidatePid: number) => {
    try {
      process.kill(candidatePid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  });
  if (!isProcessAlive(pid)) throw new Error('runtime worker process unavailable');
  return { pid, readyFile };
}

// retention 权威与内存压力共享准入门禁，避免 readyfile 与 Scheduler 语义分裂。
export function createRuntimeEventRetentionAdmissionGuard(
  base: RuntimeAdmissionGuard,
  retentionEnabled: () => boolean,
  statusPersistenceAvailable: () => boolean,
): RuntimeAdmissionGuard {
  return {
    start: () => base.start(),
    stop: () => base.stop(),
    canAcquire: () => base.canAcquire()
      && (!retentionEnabled() || statusPersistenceAvailable()),
    getSnapshot: () => includeRuntimeEventRetentionReadiness(
      base.getSnapshot(),
      retentionEnabled(),
      statusPersistenceAvailable(),
    ),
  };
}

export function includeRuntimeEventRetentionReadiness(
  snapshot: RuntimeAdmissionSnapshot,
  retentionEnabled: boolean,
  statusPersistenceAvailable: boolean,
  now: () => number = Date.now,
): RuntimeAdmissionSnapshot {
  if (!retentionEnabled || statusPersistenceAvailable) return snapshot;
  return {
    ...snapshot,
    state: 'paused',
    admitting: false,
    sampledAt: new Date(now()).toISOString(),
    reason: 'runtime_event_retention_status_unavailable',
  };
}

export function resolveRuntimeAdmissionSnapshotReader(
  processRole: string | undefined,
  getLocalSnapshot: (() => RuntimeAdmissionSnapshot | undefined) | undefined,
  getActiveWorkerSnapshot: () => RuntimeAdmissionSnapshot = readActiveRuntimeWorkerAdmissionSnapshot,
): (() => RuntimeAdmissionSnapshot | undefined) | undefined {
  if (processRole === 'ws-only') return getActiveWorkerSnapshot;
  return getLocalSnapshot;
}

function unavailableSnapshot(sampledAt: string): RuntimeAdmissionSnapshot {
  return {
    state: 'paused',
    admitting: false,
    sampledAt,
    reason: 'runtime_worker_not_ready',
  };
}
