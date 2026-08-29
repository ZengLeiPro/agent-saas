import { describe, expect, it, vi } from 'vitest';

import {
  RuntimeSessionStatusReconciler,
  runtimeSessionStatusForTerminalRun,
  type RuntimeSessionStatusCandidate,
  type RuntimeSessionStatusInspection,
  type RuntimeSessionStatusReconciliationStore,
} from '../runtime/runtimeSessionStatusReconciler.js';
import type { RuntimeSessionStatus } from '../runtime/sessionCatalog.js';

function candidate(
  overrides: Partial<RuntimeSessionStatusCandidate> = {},
): RuntimeSessionStatusCandidate {
  return {
    sessionId: 'sub-00000000-0000-4000-8000-000000000001',
    tenantId: 'kaiyan',
    kind: 'subagent',
    projectionStatus: 'running',
    metaStatus: 'running',
    latestRunId: 'run-1',
    latestRunStatus: 'orphaned',
    latestRunUpdatedAt: '2026-08-30T00:00:00.000Z',
    ...overrides,
  };
}

function fakeStore(
  rows: RuntimeSessionStatusCandidate[],
  inspection: RuntimeSessionStatusInspection,
): RuntimeSessionStatusReconciliationStore & { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => true);
  return {
    close,
    listCandidates: async (limit) => rows.slice(0, limit),
    inspect: async () => inspection,
    closeProjectionIfStillStale: close,
  };
}

function fakeLock(acquired = true) {
  const release = vi.fn(async () => undefined);
  return {
    release,
    lock: {
      tryAcquire: vi.fn(async () => (acquired ? { release, released: false, key: 1n } : null)),
    },
  };
}

describe('RuntimeSessionStatusReconciler', () => {
  it.each([
    ['subagent', 'completed', 'finished'],
    ['subagent', 'failed', 'error'],
    ['subagent', 'cancelled', 'error'],
    ['subagent', 'orphaned', 'error'],
    ['user', 'completed', 'idle'],
    ['user', 'cancelled', 'idle'],
    ['user', 'failed', 'error'],
    ['user', 'orphaned', 'error'],
  ] as const)('maps %s %s to %s', (kind, status, expected) => {
    expect(runtimeSessionStatusForTerminalRun(kind, status)).toBe(expected);
  });

  it('keeps dry-run strictly read-only', async () => {
    const row = candidate();
    const store = fakeStore([row], {
      projectionStatus: 'running',
      metaStatus: 'running',
      latestRunId: row.latestRunId,
      latestRunStatus: row.latestRunStatus,
    });
    const { lock } = fakeLock();
    const updateMetaStatus = vi.fn(async () => true);
    const reconciler = new RuntimeSessionStatusReconciler({
      store,
      sessionLock: lock,
      updateMetaStatus,
    });

    const summary = await reconciler.runOnce({ execute: false });

    expect(summary).toMatchObject({ scanned: 1, repaired: 0, failed: 0 });
    expect(summary.outcomes[0]).toMatchObject({ result: 'planned', target: 'error' });
    expect(lock.tryAcquire).not.toHaveBeenCalled();
    expect(updateMetaStatus).not.toHaveBeenCalled();
    expect(store.close).not.toHaveBeenCalled();
  });

  it('repairs meta first, then the PG projection under the session lease', async () => {
    const row = candidate();
    const store = fakeStore([row], {
      projectionStatus: 'running',
      metaStatus: 'running',
      latestRunId: row.latestRunId,
      latestRunStatus: row.latestRunStatus,
    });
    const { lock, release } = fakeLock();
    const calls: string[] = [];
    const updateMetaStatus = vi.fn(async (_sessionId: string, status: RuntimeSessionStatus) => {
      calls.push(`meta:${status}`);
      return true;
    });
    store.close.mockImplementation(async () => {
      calls.push('pg:error');
      return true;
    });
    const reconciler = new RuntimeSessionStatusReconciler({
      store,
      sessionLock: lock,
      updateMetaStatus,
    });

    const summary = await reconciler.runOnce();

    expect(summary).toMatchObject({ scanned: 1, repaired: 1, failed: 0 });
    expect(calls).toEqual(['meta:error', 'pg:error']);
    expect(release).toHaveBeenCalledOnce();
  });

  it('closes the PG projection and reports a missing transcript meta', async () => {
    const row = candidate({ transcriptPath: '/missing/session.jsonl' });
    const store = fakeStore([row], {
      projectionStatus: 'running',
      metaStatus: 'running',
      latestRunId: row.latestRunId,
      latestRunStatus: row.latestRunStatus,
    });
    const { lock } = fakeLock();
    const updateMetaStatus = vi.fn(async () => false);
    const reconciler = new RuntimeSessionStatusReconciler({
      store,
      sessionLock: lock,
      updateMetaStatus,
    });

    const summary = await reconciler.runOnce();

    expect(summary).toMatchObject({ scanned: 1, repaired: 1, missingMeta: 1, failed: 0 });
    expect(summary.outcomes[0]?.result).toBe('repaired_without_meta');
    expect(store.close).toHaveBeenCalledOnce();
  });

  it('rechecks after acquiring the lease and leaves a newly active session untouched', async () => {
    const row = candidate();
    const store = fakeStore([row], {
      projectionStatus: 'running',
      metaStatus: 'running',
      latestRunId: 'run-2',
      latestRunStatus: 'running',
      activeRunStatus: 'running',
    });
    const { lock } = fakeLock();
    const updateMetaStatus = vi.fn(async () => true);
    const reconciler = new RuntimeSessionStatusReconciler({
      store,
      sessionLock: lock,
      updateMetaStatus,
    });

    const summary = await reconciler.runOnce();

    expect(summary).toMatchObject({ scanned: 1, repaired: 0, skippedChanged: 1 });
    expect(updateMetaStatus).not.toHaveBeenCalled();
    expect(store.close).not.toHaveBeenCalled();
  });

  it('restores meta to active when a run appears during the final PG CAS', async () => {
    const row = candidate();
    let inspections = 0;
    const store = fakeStore([row], {});
    store.inspect = vi.fn(async () => {
      inspections += 1;
      return inspections === 1
        ? {
            projectionStatus: 'running',
            metaStatus: 'running',
            latestRunId: row.latestRunId,
            latestRunStatus: row.latestRunStatus,
          }
        : {
            projectionStatus: 'running',
            metaStatus: 'error',
            latestRunId: 'run-2',
            latestRunStatus: 'pending' as const,
            activeRunStatus: 'pending' as const,
          };
    });
    store.close.mockResolvedValue(false);
    const { lock } = fakeLock();
    const statuses: RuntimeSessionStatus[] = [];
    const updateMetaStatus = vi.fn(async (_sessionId: string, status: RuntimeSessionStatus) => {
      statuses.push(status);
      return true;
    });
    const reconciler = new RuntimeSessionStatusReconciler({
      store,
      sessionLock: lock,
      updateMetaStatus,
    });

    const summary = await reconciler.runOnce();

    expect(summary.skippedChanged).toBe(1);
    expect(statuses).toEqual(['error', 'running']);
  });
});
