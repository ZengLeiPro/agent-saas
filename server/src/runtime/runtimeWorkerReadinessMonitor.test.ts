import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigIdentitySummary } from '@agent/shared';
import type { RuntimeAdmissionSnapshot } from './memoryPressureGuard.js';
import {
  createRuntimeWorkerReadinessMonitor,
  safeAdmissionDiagnostic,
  safeWorkerDiagnosticIdentity,
} from './runtimeWorkerReadinessMonitor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'worker-readiness-monitor-'));
  dirs.push(dir);
  const readyFile = join(dir, 'worker.ready');
  let summary = {
    schemaVersion: 1,
    status: 'consistent',
    releaseId: 'rc-20260911-117',
  } as ConfigIdentitySummary;
  let admission: RuntimeAdmissionSnapshot = { state: 'healthy', admitting: true };
  let current = true;
  const logger = { warn: vi.fn() };
  const refresh = vi.fn(async () => summary);
  const monitor = createRuntimeWorkerReadinessMonitor({
    readyFile,
    refreshConfigIdentity: refresh,
    getConfigIdentity: () => summary,
    getAdmission: () => admission,
    privateSnapshotCurrent: () => current,
    logger,
    identity: {
      pid: 4321,
      bootId: '11111111-2222-3333-4444-555555555555',
      processStartTicks: '12345',
      environment: 'production',
      releaseId: 'rc-20260911-117',
      releaseSha: 'a'.repeat(40),
      serverDigest: `sha256:${'b'.repeat(64)}`,
    },
  });
  return {
    dir,
    readyFile,
    monitor,
    refresh,
    logger,
    status: () => JSON.parse(readFileSync(`${readyFile}.status.json`, 'utf8')),
    config: (status: ConfigIdentitySummary['status']) => {
      summary = { ...summary, status } as ConfigIdentitySummary;
    },
    admission: (next: RuntimeAdmissionSnapshot) => {
      admission = next;
    },
    current: (value: boolean) => {
      current = value;
    },
    summary: () => summary,
  };
}
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe('Runtime Worker readiness projection lifecycle', () => {
  it('publishes a protected PID-bound status without replacing the actual admission contract', async () => {
    const f = fixture();
    await f.monitor.sync();
    expect(readFileSync(f.readyFile, 'utf8')).toBe('4321\n');
    expect(f.status()).toMatchObject({
      schemaVersion: 1,
      pid: 4321,
      processStartTicks: '12345',
      environment: 'production',
      state: 'ready',
      privateSnapshotCurrent: true,
      configStatus: 'consistent',
      refresh: { pending: false },
    });
    expect(statSync(`${f.readyFile}.status.json`).mode & 0o777).toBe(0o600);
    expect(existsSync(`${f.readyFile}.org-group-agent-background-v2`)).toBe(true);
  });

  it('withdraws for memory pressure and automatically recreates only after true admission recovery', async () => {
    const f = fixture();
    await f.monitor.sync();
    f.admission({
      state: 'paused',
      admitting: false,
      reason: 'host_mem_available_low',
      availableBytes: 100,
    });
    await f.monitor.sync();
    expect(existsSync(f.readyFile)).toBe(false);
    expect(existsSync(`${f.readyFile}.org-group-agent-background-v2`)).toBe(false);
    expect(f.status()).toMatchObject({
      state: 'admission_paused',
      admission: { reason: 'host_mem_available_low', admitting: false, availableBytes: 100 },
    });
    f.admission({ state: 'healthy', admitting: true });
    await f.monitor.sync();
    expect(existsSync(f.readyFile)).toBe(true);
    expect(f.status().state).toBe('ready');
  });

  it.each(['drifted', 'unverifiable', 'not_collected'] as const)(
    'keeps config %s fail-closed and recovers normally',
    async (status) => {
      const f = fixture();
      await f.monitor.sync();
      f.config(status);
      await f.monitor.sync();
      expect(existsSync(f.readyFile)).toBe(false);
      expect(f.status().state).toBe(`config_${status}`);
      f.config('consistent');
      await f.monitor.sync();
      expect(existsSync(f.readyFile)).toBe(true);
    },
  );

  it('private snapshot failure remains independently blocking even with consistent in-memory identity', async () => {
    const f = fixture();
    await f.monitor.sync();
    f.current(false);
    await f.monitor.sync();
    expect(existsSync(f.readyFile)).toBe(false);
    expect(f.status().state).toBe('private_snapshot_unavailable');
    f.current(true);
    await f.monitor.sync();
    expect(existsSync(f.readyFile)).toBe(true);
  });

  it('retention authority failure is reported without mislabelling it as memory pressure', async () => {
    const f = fixture();
    f.admission({
      state: 'paused',
      admitting: false,
      reason: 'runtime_event_retention_status_unavailable',
    });
    await f.monitor.sync();
    expect(existsSync(f.readyFile)).toBe(false);
    expect(f.status().admission.reason).toBe('runtime_event_retention_status_unavailable');
  });

  it('fast periodic refreshes do not flicker a previously healthy readyfile', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.monitor.sync();
    const mtime = statSync(f.readyFile).mtimeMs;
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await f.monitor.sync();
      expect(existsSync(f.readyFile)).toBe(true);
    }
    expect(statSync(f.readyFile).mtimeMs).toBe(mtime);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('slow refresh withdraws both ready tokens, coalesces calls, and recovers once the real refresh returns', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.monitor.sync();
    const delayed = pending<ConfigIdentitySummary>();
    f.refresh.mockImplementationOnce(() => delayed.promise);
    const work = f.monitor.sync();
    await vi.advanceTimersByTimeAsync(999);
    expect(existsSync(f.readyFile)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(existsSync(f.readyFile)).toBe(false);
    expect(existsSync(`${f.readyFile}.org-group-agent-background-v2`)).toBe(false);
    expect(f.status()).toMatchObject({
      state: 'config_refresh_slow',
      refresh: { pending: true, slow: true },
    });
    await f.monitor.sync();
    await f.monitor.sync();
    expect(f.refresh).toHaveBeenCalledTimes(2);
    delayed.resolve(f.summary());
    await work;
    expect(existsSync(f.readyFile)).toBe(true);
    expect(f.status().state).toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a late refresh cannot recreate readiness after drain begins', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.monitor.sync();
    const delayed = pending<ConfigIdentitySummary>();
    f.refresh.mockImplementationOnce(() => delayed.promise);
    const work = f.monitor.sync();
    f.monitor.stop();
    expect(existsSync(f.readyFile)).toBe(false);
    expect(f.status().state).toBe('draining');
    delayed.resolve(f.summary());
    await work;
    await f.monitor.sync();
    expect(existsSync(f.readyFile)).toBe(false);
    expect(f.status().state).toBe('draining');
    expect(f.refresh).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('failed refresh releases pending state and redacts thrown private content', async () => {
    const f = fixture();
    await f.monitor.sync();
    f.refresh.mockRejectedValueOnce(new Error('SECRET_TOKEN=do-not-export /etc/private'));
    await f.monitor.sync();
    expect(existsSync(f.readyFile)).toBe(false);
    expect(f.status().state).toBe('projection_failed');
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toMatch(/SECRET_TOKEN|etc\/private/);
    await f.monitor.sync();
    expect(existsSync(f.readyFile)).toBe(true);
  });

  it('diagnostic publication errors never manufacture readiness and are recoverable', async () => {
    const f = fixture();
    f.current(false);
    mkdirSync(`${f.readyFile}.status.json`);
    await f.monitor.sync();
    expect(existsSync(f.readyFile)).toBe(false);
    expect(f.logger.warn).toHaveBeenCalled();
    rmSync(`${f.readyFile}.status.json`, { recursive: true });
    f.current(true);
    await f.monitor.sync();
    expect(f.status().state).toBe('ready');
    expect(existsSync(f.readyFile)).toBe(true);
  });

  it('diagnostic projection excludes unrecognized strings, secrets and non-finite metrics', () => {
    const admission = safeAdmissionDiagnostic({
      state: 'paused',
      admitting: false,
      reason: 'SECRET=value',
      availableBytes: Number.NaN,
      psiSomeAvg10: Number.POSITIVE_INFINITY,
    });
    expect(admission.reason).toBe('unclassified');
    expect(admission).not.toHaveProperty('availableBytes');
    expect(JSON.stringify(admission)).not.toContain('SECRET');
    const identity = safeWorkerDiagnosticIdentity({
      pid: 1,
      environment: 'SECRET',
      releaseSha: 'not-sha',
      releaseId: '/secret',
      bootId: 'bad',
      processStartTicks: 'bad',
    });
    expect(identity).toMatchObject({
      environment: null,
      releaseSha: null,
      releaseId: null,
      bootId: null,
      processStartTicks: null,
    });
  });
});
