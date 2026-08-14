import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';

class CapacityPool {
  readonly queries: string[] = [];
  updateCalls = 0;
  rollbackCalls = 0;
  releaseCalls = 0;

  constructor(private readonly activeCount: number) {}

  async connect(): Promise<pg.PoolClient> {
    return {
      query: async <T>(sql: string, params: unknown[] = []) => {
        this.queries.push(sql);
        if (sql === 'ROLLBACK') this.rollbackCalls += 1;
        if (sql.includes('COUNT(*) AS active_count')) {
          return { rows: [{ active_count: this.activeCount }] as T[] };
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
                metadata: {},
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

describe('PgRunStore global scheduler capacity', () => {
  it('skips startup ALTER TABLE statements when every compatibility column exists', async () => {
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
    });

    await store.init();

    expect(queries.some((sql) => sql.includes('FROM pg_attribute'))).toBe(true);
    expect(queries.some((sql) => sql.includes('ALTER TABLE runtime_runs'))).toBe(false);
  });

  it('refuses a new run lease when another instance already filled the global cap', async () => {
    const pool = new CapacityPool(2);
    const store = new PgRunStore({ pool: pool as unknown as pg.Pool });

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
  });

  it('atomically claims a run lease while capacity remains', async () => {
    const pool = new CapacityPool(1);
    const store = new PgRunStore({ pool: pool as unknown as pg.Pool });

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
    expect(leaseSql).toContain("active.status IN ('running','waiting_approval','waiting_user','waiting_hand')");
    expect(leaseSql).toContain("predecessor.status = 'pending'");
    expect(pool.queries).toContain('COMMIT');
    expect(pool.releaseCalls).toBe(1);
  });
});
