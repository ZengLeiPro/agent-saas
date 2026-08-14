import { describe, expect, it } from 'vitest';

import { acquireDirectRuntimeRunLease, startWakeLeaseRenewal } from '../runtime/rawRuntimeRunDispatch.js';
import type { RunRecord, RunStore } from '../runtime/runStore.js';

function runRecord(runId: string, workerId: string): RunRecord {
  const now = new Date().toISOString();
  return {
    runId,
    sessionId: 'session-1',
    status: 'running',
    workerId,
    requestedAt: now,
    updatedAt: now,
    metadata: {},
  };
}

describe('acquireDirectRuntimeRunLease', () => {
  it('acquires and releases a lease for direct runtime runs', async () => {
    let acquiredWorkerId: string | undefined;
    let releasedWorkerId: string | undefined;
    const runStore = {
      acquireLease: async (runId: string, workerId: string, leaseMs: number) => {
        expect(runId).toBe('run-direct');
        expect(leaseMs).toBeGreaterThan(0);
        acquiredWorkerId = workerId;
        return runRecord(runId, workerId);
      },
      releaseLease: async (runId: string, workerId: string) => {
        expect(runId).toBe('run-direct');
        releasedWorkerId = workerId;
        return runRecord(runId, workerId);
      },
    } as unknown as RunStore;

    const lease = await acquireDirectRuntimeRunLease({ runStore, runId: 'run-direct' });

    expect(lease?.workerId).toBe(acquiredWorkerId);
    await lease?.release();
    expect(releasedWorkerId).toBe(acquiredWorkerId);
  });

  it('does not acquire a direct lease for scheduler-owned wake runs', async () => {
    let acquireCalls = 0;
    const runStore = {
      acquireLease: async () => {
        acquireCalls += 1;
        return null;
      },
    } as unknown as RunStore;

    const lease = await acquireDirectRuntimeRunLease({
      runStore,
      runId: 'run-scheduler',
      runtimeWorkerId: 'worker-1',
    });

    expect(lease).toBeNull();
    expect(acquireCalls).toBe(0);
  });

  it('fails closed when another run owns the session lease', async () => {
    const runStore = {
      acquireLease: async () => null,
    } as unknown as RunStore;

    await expect(acquireDirectRuntimeRunLease({ runStore, runId: 'run-blocked' }))
      .rejects.toThrow('Direct runtime lease not acquired run=run-blocked');
  });

  it('fails closed when durable lease acquisition throws', async () => {
    const runStore = {
      acquireLease: async () => { throw new Error('database unavailable'); },
    } as unknown as RunStore;

    await expect(acquireDirectRuntimeRunLease({ runStore, runId: 'run-db-error' }))
      .rejects.toThrow('database unavailable');
  });

  it('fails closed when a durable store cannot acquire leases', async () => {
    const runStore = {} as RunStore;

    await expect(acquireDirectRuntimeRunLease({ runStore, runId: 'run-no-lease-api' }))
      .rejects.toThrow('Direct runtime lease is unavailable run=run-no-lease-api');
  });

  it('aborts direct execution when lease renewal is rejected', async () => {
    const abortController = new AbortController();
    const runStore = {
      acquireLease: async (runId: string, workerId: string) => runRecord(runId, workerId),
      renewLease: async () => null,
      releaseLease: async () => null,
    } as unknown as RunStore;

    const lease = await acquireDirectRuntimeRunLease({
      runStore,
      runId: 'run-renew-lost',
      renewIntervalMs: 5,
      onLeaseLost: (error) => abortController.abort(error),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(abortController.signal.aborted).toBe(true);
      expect(abortController.signal.reason).toMatchObject({
        name: 'DirectRuntimeLeaseLostError',
        runId: 'run-renew-lost',
      });
    } finally {
      await lease?.release();
    }
  });
});

describe('startWakeLeaseRenewal durable cancel fallback', () => {
  // 2026-08-04 P0 兜底回归：run_cancel_requested 的主投递通道是 PG NOTIFY；
  // NOTIFY 丢失时 renewal 轮询必须在 ≤intervalMs 内感知 durable cancelled 并 abort。
  it('aborts the run when durable status turns cancelled while renewals still succeed', async () => {
    const abortController = new AbortController();
    const lease = { renew: async () => {}, release: async () => {} } as any;
    const runStore = {
      get: async () => ({
        runId: 'run-cancel',
        sessionId: 'session-1',
        status: 'cancelled',
        statusReason: 'web_abort',
        requestedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      }),
    } as unknown as RunStore;

    const timer = startWakeLeaseRenewal({
      lease,
      runStore,
      runId: 'run-cancel',
      abortController,
      intervalMs: 10,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(abortController.signal.aborted).toBe(true);
      const reason = abortController.signal.reason;
      expect(String(reason instanceof Error ? reason.message : reason)).toContain('web_abort');
    } finally {
      if (timer) clearInterval(timer);
    }
  });

  it('does not abort for completed runs (loop-owned terminal states)', async () => {
    const abortController = new AbortController();
    const lease = { renew: async () => {}, release: async () => {} } as any;
    const runStore = {
      get: async () => ({
        runId: 'run-done',
        sessionId: 'session-1',
        status: 'completed',
        requestedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      }),
    } as unknown as RunStore;

    const timer = startWakeLeaseRenewal({
      lease,
      runStore,
      runId: 'run-done',
      abortController,
      intervalMs: 10,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(abortController.signal.aborted).toBe(false);
    } finally {
      if (timer) clearInterval(timer);
    }
  });
});
