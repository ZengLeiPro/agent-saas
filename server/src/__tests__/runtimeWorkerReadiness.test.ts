import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeEventRetentionAdmissionGuard,
  includeRuntimeEventRetentionReadiness,
  isActiveRuntimeWorkerOrgAgentV2Ready,
  projectRuntimeWorkerReadyFile,
  removeRuntimeWorkerReadyFiles,
  readActiveRuntimeWorkerAdmissionSnapshot,
  resolveRuntimeAdmissionSnapshotReader,
} from '../runtime/runtimeWorkerReadiness.js';

const cleanupDirs: string[] = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-worker-readiness-'));
  cleanupDirs.push(dir);
  return {
    activeColorFile: join(dir, 'active-color'),
    readyFileForColor: (color: 'blue' | 'green') => join(dir, `${color}.ready`),
  };
}

describe('Runtime Worker split-role readiness', () => {
  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('withdraws and republishes the worker readyfile with admission transitions', () => {
    const paths = fixture();
    const readyFile = paths.readyFileForColor('blue');

    projectRuntimeWorkerReadyFile(readyFile, { state: 'healthy', admitting: true }, 4321);
    expect(readFileSync(readyFile, 'utf8')).toBe('4321\n');

    projectRuntimeWorkerReadyFile(readyFile, { state: 'paused', admitting: false }, 4321);
    expect(existsSync(readyFile)).toBe(false);

    projectRuntimeWorkerReadyFile(readyFile, { state: 'healthy', admitting: true }, 4321);
    expect(readFileSync(readyFile, 'utf8')).toBe('4321\n');
  });

  it('withdraws worker readiness until enabled retention establishes status authority', () => {
    const paths = fixture();
    const readyFile = paths.readyFileForColor('blue');
    const healthy = { state: 'healthy' as const, admitting: true, sampledAt: '2026-08-30T06:00:00.000Z' };

    const unavailable = includeRuntimeEventRetentionReadiness(healthy, true, false, () => 1_000);
    expect(unavailable).toMatchObject({
      state: 'paused',
      admitting: false,
      reason: 'runtime_event_retention_status_unavailable',
      sampledAt: '1970-01-01T00:00:01.000Z',
    });
    projectRuntimeWorkerReadyFile(readyFile, unavailable, 4321);
    expect(existsSync(readyFile)).toBe(false);

    const recovered = includeRuntimeEventRetentionReadiness(healthy, true, true);
    expect(recovered).toBe(healthy);
    projectRuntimeWorkerReadyFile(readyFile, recovered, 4321);
    expect(readFileSync(readyFile, 'utf8')).toBe('4321\n');
  });

  it('uses the same retention authority gate for scheduler acquisition and readiness', () => {
    let statusAvailable = false;
    const base = {
      start: async () => undefined,
      stop: () => undefined,
      canAcquire: () => true,
      getSnapshot: () => ({ state: 'healthy' as const, admitting: true }),
    };
    const guard = createRuntimeEventRetentionAdmissionGuard(
      base,
      () => true,
      () => statusAvailable,
    );

    expect(guard.canAcquire()).toBe(false);
    expect(guard.getSnapshot()).toMatchObject({
      state: 'paused',
      admitting: false,
      reason: 'runtime_event_retention_status_unavailable',
    });

    statusAvailable = true;
    expect(guard.canAcquire()).toBe(true);
    expect(guard.getSnapshot()).toEqual({ state: 'healthy', admitting: true });
  });

  it('reports the active live worker as admitting', () => {
    const paths = fixture();
    writeFileSync(paths.activeColorFile, 'blue\n');
    writeFileSync(paths.readyFileForColor('blue'), '1234\n');

    expect(
      readActiveRuntimeWorkerAdmissionSnapshot({
        ...paths,
        isProcessAlive: (pid) => pid === 1234,
        now: () => 1_000,
      }),
    ).toEqual({
      state: 'healthy',
      admitting: true,
      sampledAt: '1970-01-01T00:00:01.000Z',
    });
  });

  it('gates organization group activation on the active worker protocol sidecar', () => {
    const paths = fixture();
    const readyFile = paths.readyFileForColor('blue');
    writeFileSync(paths.activeColorFile, 'blue\n');
    writeFileSync(readyFile, '1234\n');
    const options = { ...paths, isProcessAlive: (pid: number) => pid === 1234 };
    expect(isActiveRuntimeWorkerOrgAgentV2Ready(options)).toBe(false);
    projectRuntimeWorkerReadyFile(readyFile, { state: 'healthy', admitting: true }, 1234);
    expect(isActiveRuntimeWorkerOrgAgentV2Ready(options)).toBe(true);
    projectRuntimeWorkerReadyFile(readyFile, { state: 'paused', admitting: false }, 1234);
    expect(isActiveRuntimeWorkerOrgAgentV2Ready(options)).toBe(false);
  });

  it('rejects a stale protocol sidecar after a legacy worker rewrites the readyfile', () => {
    const paths = fixture();
    const readyFile = paths.readyFileForColor('blue');
    writeFileSync(paths.activeColorFile, 'blue\n');
    const options = { ...paths, isProcessAlive: (pid: number) => pid === 1234 };
    projectRuntimeWorkerReadyFile(readyFile, { state: 'healthy', admitting: true }, 1234);
    expect(isActiveRuntimeWorkerOrgAgentV2Ready(options)).toBe(true);

    writeFileSync(readyFile, '1234\n');
    expect(isActiveRuntimeWorkerOrgAgentV2Ready(options)).toBe(false);
  });

  it('removes both readiness files during normal worker shutdown', () => {
    const paths = fixture();
    const readyFile = paths.readyFileForColor('blue');
    projectRuntimeWorkerReadyFile(readyFile, { state: 'healthy', admitting: true }, 1234);
    removeRuntimeWorkerReadyFiles(readyFile);
    expect(existsSync(readyFile)).toBe(false);
    expect(existsSync(`${readyFile}.org-group-agent-background-v2`)).toBe(false);
  });

  it('reads an explicitly configured active worker readyfile without production blue-green state', () => {
    const paths = fixture();
    const activeReadyFile = join(dirname(paths.activeColorFile), 'staging.ready');
    writeFileSync(activeReadyFile, '4321\n');

    expect(
      readActiveRuntimeWorkerAdmissionSnapshot({
        activeReadyFile,
        isProcessAlive: (pid) => pid === 4321,
        now: () => 0,
      }),
    ).toEqual({
      state: 'healthy',
      admitting: true,
      sampledAt: '1970-01-01T00:00:00.000Z',
    });
  });

  it.each([
    ['missing active readyfile', 'blue', undefined, true],
    ['invalid active color', 'red', '1234', true],
    ['stale active worker pid', 'green', '1234', false],
  ])('fails closed for %s', (_label, color, readyPid, alive) => {
    const paths = fixture();
    writeFileSync(paths.activeColorFile, `${color}\n`);
    if (readyPid)
      writeFileSync(paths.readyFileForColor(color as 'blue' | 'green'), `${readyPid}\n`);

    expect(
      readActiveRuntimeWorkerAdmissionSnapshot({
        ...paths,
        isProcessAlive: () => alive,
        now: () => 2_000,
      }),
    ).toEqual({
      state: 'paused',
      admitting: false,
      sampledAt: '1970-01-01T00:00:02.000Z',
      reason: 'runtime_worker_not_ready',
    });
  });

  it('uses the active worker projection for ws-only instead of its unsampled local guard', () => {
    const local = () => ({ state: 'unknown' as const, admitting: true });
    const activeWorker = () => ({
      state: 'paused' as const,
      admitting: false,
      reason: 'runtime_worker_not_ready',
    });

    expect(resolveRuntimeAdmissionSnapshotReader('ws-only', local, activeWorker)?.()).toEqual(
      activeWorker(),
    );
    expect(
      resolveRuntimeAdmissionSnapshotReader('runtime-worker', local, activeWorker)?.(),
    ).toEqual(local());
  });
});
