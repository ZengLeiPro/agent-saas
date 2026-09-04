import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';

class CapacityPool {
  readonly queries: string[] = []; // captured SQL is asserted below
  updateCalls = 0;
  rollbackCalls = 0;
  releaseCalls = 0;

  constructor(
    private readonly activeCount: number,
    private parentActive = true,
    private inheritedActive = false,
    private candidateEligible = true,
  ) {}

  setInheritedActive(active: boolean): void {
    this.inheritedActive = active;
  }

  async connect(): Promise<pg.PoolClient> {
    return {
      query: async <T>(sql: string, params: unknown[] = []) => {
        this.queries.push(sql);
        if (sql === 'ROLLBACK') this.rollbackCalls += 1;
        if (sql.includes('COUNT(*) AS active_count')) {
          return { rows: [{ active_count: this.activeCount }] as T[] };
        }
        if (sql.includes('AS parent_active')) {
          return { rows: [{
            parent_active: this.parentActive,
            candidate_eligible: this.candidateEligible,
            inherited_active: this.inheritedActive,
          }] as T[] };
        }
        if (sql.includes('SELECT tenant_id, session_id FROM runtime_runs')) {
          return { rows: [{ tenant_id: 'tenant-1', session_id: 'session-1' }] as T[] };
        }
        if (sql.includes('SELECT session_id FROM runtime_runs')) {
          return { rows: [{ session_id: 'session-1' }] as T[] };
        }
        if (sql.includes('UPDATE runtime_runs')) {
          this.updateCalls += 1;
          const now = String(params[3]);
          return {
            rows: [{
              row_json: {
                run_id: String(params[0]),
                session_id: 'session-1',
                status: 'running',
                requested_at: now,
                updated_at: now,
                worker_id: String(params[1]),
                lease_expires_at: String(params[2]),
                metadata: params[4] ? { subagentCapacityInherited: true } : {},
              },
            }] as T[],
          };
        }
        return { rows: [] as T[] };
      },
      release: () => {
        this.releaseCalls += 1;
      },
    } as unknown as pg.PoolClient;
  }
}

describe('PgRunStore unified parent/child scheduler capacity, liveness and schema compatibility using an explicit test writer', () => {
  it('skips startup ALTER TABLE statements when all compatibility columns exist', async () => {
    const queries: string[] = [];
    const existingColumns = [
      'enqueue_seq',
      'last_response_id',
      'last_response_expire_at',
      'actual_model_seen',
      'last_response_model',
      'last_response_profile_digest',
      'cumulative_input_tokens',
      'sandbox_scope_id',
      'tenant_id',
      'submitter_scope',
      'last_heartbeat_at',
      'liveness_state',
      'liveness_reason_code',
      'liveness_detected_at',
      'liveness_version',
    ];
    const client = {
      query: async <T>(sql: string) => {
        queries.push(sql);
        return {
          rows: (sql.includes('FROM pg_attribute')
            ? existingColumns.map((column_name) => ({ column_name }))
            : []) as T[],
        };
      },
      release: () => undefined,
    };
    const store = new PgRunStore({
      pool: { connect: async () => client } as unknown as pg.Pool,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
    });

    await store.init();

    expect(queries.some((sql) => sql.includes('FROM pg_attribute'))).toBe(true);
    expect(queries.filter((sql) => /ALTER TABLE runtime_runs (?:ADD|ALTER) COLUMN/.test(sql))).toEqual([]);
  });

  it('refuses a new run lease when another instance already filled the global cap', async () => {
    const pool = new CapacityPool(2);
    const store = new PgRunStore({
      pool: pool as unknown as pg.Pool,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
    });

    const acquired = await store.acquireLease(
      'run-capacity-full',
      'worker-blue',
      60_000,
      new Date('2026-07-27T14:00:00.000Z'),
      2,
    );

    expect(acquired).toBeNull();
    expect(pool.updateCalls).toBe(0);
    expect(pool.rollbackCalls).toBe(1);
    expect(pool.releaseCalls).toBe(1);
    expect(pool.queries.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(pool.queries.some((sql) => sql.includes("metadata->>'subagentCapacityInherited'"))).toBe(true);
  });

  it('atomically claims a run lease while capacity remains', async () => {
    const pool = new CapacityPool(1);
    const store = new PgRunStore({
      pool: pool as unknown as pg.Pool,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
    });

    const acquired = await store.acquireLease(
      'run-capacity-open',
      'worker-green',
      60_000,
      new Date('2026-07-27T14:00:00.000Z'),
      2,
    );

    expect(acquired).toMatchObject({
      runId: 'run-capacity-open',
      workerId: 'worker-green',
      status: 'running',
    });
    expect(pool.updateCalls).toBe(1);
    expect(pool.queries.filter((sql) => sql.includes('pg_advisory_xact_lock'))).toHaveLength(2);
    const leaseSql = pool.queries.find((sql) => sql.includes('UPDATE runtime_runs'));
    expect(leaseSql).toContain("active.status IN ('running','waiting_hand')");
    expect(pool.queries.some((sql) => sql.includes("active_run.metadata->>'subagentCapacityInherited' = 'true'"))).toBe(true);
    expect(leaseSql).not.toContain("active.status IN ('running','waiting_approval','waiting_user','waiting_hand')");
    expect(leaseSql).toContain("predecessor.status = 'pending'");
    expect(pool.queries).toContain('COMMIT');
    expect(pool.releaseCalls).toBe(1);
  });

  it('atomically grants one child the active parent slot even when the global cap is full', async () => {
    const pool = new CapacityPool(2);
    const store = new PgRunStore({
      pool: pool as unknown as pg.Pool,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
    });

    await expect(store.acquireLease(
      'run-child', 'worker-child', 60_000, new Date('2026-08-30T16:00:00.000Z'), 2,
      { foreground: true, foregroundReservedRuns: 1, inheritFromRunId: 'run-parent' },
    )).resolves.toMatchObject({
      runId: 'run-child',
      status: 'running',
      metadata: { subagentCapacityInherited: true },
    });
    expect(pool.queries.some((sql) => sql.includes('AS parent_active'))).toBe(true);
    expect(pool.queries.some((sql) => sql.includes('COUNT(*) AS active_count'))).toBe(false);
    expect(pool.queries.find((sql) => sql.includes('UPDATE runtime_runs'))).toContain('subagentCapacityInherited');
    expect(pool.queries.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  it('keeps a sibling on a normal slot while another inherited child is active', async () => {
    const pool = new CapacityPool(1, true, true);
    const store = new PgRunStore({
      pool: pool as unknown as pg.Pool,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
    });
    await expect(store.acquireLease(
      'run-child-normal', 'worker-child', 60_000, new Date('2026-08-30T16:00:00.000Z'), 2,
      { foreground: true, foregroundReservedRuns: 1, inheritFromRunId: 'run-parent' },
    )).resolves.toMatchObject({ runId: 'run-child-normal', metadata: {} });
    expect(pool.queries.some((sql) => sql.includes('COUNT(*) AS active_count'))).toBe(true);
  });

  it('hands the inherited parent slot to an already-waiting sibling after the current child finishes', async () => {
    const pool = new CapacityPool(2, true, true);
    const store = new PgRunStore({
      pool: pool as unknown as pg.Pool,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
    });
    const admission = { foreground: true, foregroundReservedRuns: 1, inheritFromRunId: 'run-parent' };

    await expect(store.acquireLease(
      'run-child-2', 'worker-child', 60_000, new Date('2026-08-30T16:00:00.000Z'), 2, admission,
    )).resolves.toBeNull();
    pool.setInheritedActive(false);
    await expect(store.acquireLease(
      'run-child-2', 'worker-child', 60_000, new Date('2026-08-30T16:00:01.000Z'), 2, admission,
    )).resolves.toMatchObject({
      runId: 'run-child-2',
      status: 'running',
      metadata: { subagentCapacityInherited: true },
    });
    expect(pool.updateCalls).toBe(1);
  });

  it('does not inherit or start after the parent lease is no longer active', async () => {
    const pool = new CapacityPool(1, false);
    const store = new PgRunStore({
      pool: pool as unknown as pg.Pool,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
    });
    await expect(store.acquireLease(
      'run-orphan-child', 'worker-child', 60_000, new Date('2026-08-30T16:00:00.000Z'), 2,
      { foreground: true, foregroundReservedRuns: 1, inheritFromRunId: 'run-parent' },
    )).resolves.toBeNull();
    expect(pool.updateCalls).toBe(0);
  });

  it('reserves global capacity for foreground runs', async () => {
    const lowPriorityPool = new CapacityPool(1);
    const lowPriorityStore = new PgRunStore({ pool: lowPriorityPool as unknown as pg.Pool });
    await expect(lowPriorityStore.acquireLease(
      'run-taskboard', 'worker-background', 60_000, new Date('2026-08-24T14:00:00.000Z'), 2,
      { foreground: false, foregroundReservedRuns: 1 },
    )).resolves.toBeNull();

    const foregroundPool = new CapacityPool(1);
    const foregroundStore = new PgRunStore({ pool: foregroundPool as unknown as pg.Pool });
    await expect(foregroundStore.acquireLease(
      'run-user-message', 'worker-foreground', 60_000, new Date('2026-08-24T14:00:00.000Z'), 2,
      { foreground: true, foregroundReservedRuns: 1 },
    )).resolves.toMatchObject({ runId: 'run-user-message', status: 'running' });
  });
});
