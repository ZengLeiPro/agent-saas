import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GovernanceProjectionReconciler } from '../data/governanceProjection/reconciler.js';
import { PgGovernanceProjectionOutboxStore } from '../data/governanceProjection/store.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('Governance Projection PostgreSQL 连接池契约', () => {
  const prefix = `govpool_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgGovernanceProjectionOutboxStore;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: testPgUrl!,
      connectionTimeoutMillis: 1_000,
      max: 6,
    });
    store = new PgGovernanceProjectionOutboxStore({ pool, tablePrefix: prefix });
    await pool.query(`CREATE TABLE ${store.outboxTable} (
      outbox_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      projector TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_json JSONB NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'retry_wait', 'succeeded', 'failed')),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts >= 1),
      lease_fence BIGINT NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ,
      last_error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      UNIQUE (tenant_id, projector, idempotency_key)
    )`);
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${store.outboxTable}`);
    } finally {
      await pool.end();
    }
  });

  it('max=6 的共享池可完成 7 个带 advisory fence 的投影，不发生自锁', async () => {
    for (let index = 0; index < 7; index += 1) {
      await store.enqueue({
        tenantId: 'tenant-a',
        projector: 'assignment',
        idempotencyKey: `skill:${index}:1`,
        payload: { resourceType: 'skill', resourceId: `skill-${index}` },
      });
    }

    const reconciler = new GovernanceProjectionReconciler({
      store,
      workerId: 'pool-regression-worker',
      projectors: {
        assignment: async () => {
          await pool.query('SELECT 1');
        },
      },
      executeFenced: async (item, operation) => {
        const fenceKey = `${item.tenantId}:${item.projector}:${String(item.payload.resourceId)}`;
        const client = await pool.connect();
        let locked = false;
        try {
          await client.query('SELECT pg_advisory_lock(hashtext($1))', [fenceKey]);
          locked = true;
          await operation();
        } finally {
          if (locked) {
            await client.query('SELECT pg_advisory_unlock(hashtext($1))', [fenceKey]);
          }
          client.release();
        }
      },
    });

    await expect(reconciler.reconcileBatch(7)).resolves.toHaveLength(7);
    const statuses = await pool.query<{ status: string; count: string }>(`
      SELECT status, count(*) AS count
      FROM ${store.outboxTable}
      GROUP BY status
    `);
    expect(statuses.rows).toEqual([{ status: 'succeeded', count: '7' }]);
  }, 15_000);
});
