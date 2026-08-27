import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  projectRuntimeWorkerReadyFile,
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

  it('reports the active live worker as admitting', () => {
    const paths = fixture();
    writeFileSync(paths.activeColorFile, 'blue\n');
    writeFileSync(paths.readyFileForColor('blue'), '1234\n');

    expect(readActiveRuntimeWorkerAdmissionSnapshot({
      ...paths,
      isProcessAlive: (pid) => pid === 1234,
      now: () => 1_000,
    })).toEqual({
      state: 'healthy',
      admitting: true,
      sampledAt: '1970-01-01T00:00:01.000Z',
    });
  });

  it.each([
    ['missing active readyfile', 'blue', undefined, true],
    ['invalid active color', 'red', '1234', true],
    ['stale active worker pid', 'green', '1234', false],
  ])('fails closed for %s', (_label, color, readyPid, alive) => {
    const paths = fixture();
    writeFileSync(paths.activeColorFile, `${color}\n`);
    if (readyPid) writeFileSync(paths.readyFileForColor(color as 'blue' | 'green'), `${readyPid}\n`);

    expect(readActiveRuntimeWorkerAdmissionSnapshot({
      ...paths,
      isProcessAlive: () => alive,
      now: () => 2_000,
    })).toEqual({
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

    expect(resolveRuntimeAdmissionSnapshotReader('ws-only', local, activeWorker)?.())
      .toEqual(activeWorker());
    expect(resolveRuntimeAdmissionSnapshotReader('runtime-worker', local, activeWorker)?.())
      .toEqual(local());
  });
});
