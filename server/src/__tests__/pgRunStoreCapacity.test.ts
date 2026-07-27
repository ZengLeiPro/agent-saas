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
    expect(pool.queries).toContain('COMMIT');
    expect(pool.releaseCalls).toBe(1);
  });
});
