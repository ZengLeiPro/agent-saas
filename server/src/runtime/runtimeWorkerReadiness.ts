import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { RuntimeAdmissionSnapshot } from './memoryPressureGuard.js';

const ACTIVE_COLOR_FILE = '/etc/agent-saas/runtime-worker-active-color';

export interface RuntimeWorkerReadinessOptions {
  activeColorFile?: string;
  activeReadyFile?: string;
  readyFileForColor?: (color: 'blue' | 'green') => string;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
}

export function projectRuntimeWorkerReadyFile(
  readyFile: string,
  snapshot: RuntimeAdmissionSnapshot | undefined,
  pid = process.pid,
): void {
  if (snapshot?.admitting === false) {
    rmSync(readyFile, { force: true });
    return;
  }
  const expected = `${pid}\n`;
  try {
    if (readFileSync(readyFile, 'utf8') === expected) return;
  } catch {
    /* 首次发布或外部清理后重建 */
  }
  writeFileSync(readyFile, expected, 'utf8');
}

export function readActiveRuntimeWorkerAdmissionSnapshot(
  options: RuntimeWorkerReadinessOptions = {},
): RuntimeAdmissionSnapshot {
  const sampledAt = new Date((options.now ?? Date.now)()).toISOString();
  try {
    let readyFile =
      options.activeReadyFile ?? process.env.AGENT_SAAS_ACTIVE_RUNTIME_WORKER_READYFILE;
    if (!readyFile) {
      const color = readFileSync(options.activeColorFile ?? ACTIVE_COLOR_FILE, 'utf8').trim();
      if (color !== 'blue' && color !== 'green') return unavailableSnapshot(sampledAt);
      readyFile =
        options.readyFileForColor?.(color) ?? `/run/agent-saas-runtime-worker-${color}.ready`;
    }
    const pid = Number(readFileSync(readyFile, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return unavailableSnapshot(sampledAt);
    const isProcessAlive =
      options.isProcessAlive ??
      ((candidatePid: number) => {
        try {
          process.kill(candidatePid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'EPERM';
        }
      });
    if (!isProcessAlive(pid)) return unavailableSnapshot(sampledAt);
    return { state: 'healthy', admitting: true, sampledAt };
  } catch {
    return unavailableSnapshot(sampledAt);
  }
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
