import { describe, expect, it } from 'vitest';

import { acquireDirectRuntimeRunLease } from '../runtime/rawRuntimeRunDispatch.js';
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
});
