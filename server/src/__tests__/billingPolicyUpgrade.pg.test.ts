import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CREDIT_MICRO } from '../data/billing/types.js';
import { PgBillingStore } from '../data/billing/pgBillingStore.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('Billing policy PostgreSQL 升级契约', () => {
  const prefix = `billing_upgrade_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      const tables = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE $1`,
        [`${prefix}%`],
      );
      for (const { tablename } of tables.rows) {
        await pool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
      }
    } finally {
      await pool.end();
    }
  });

  it('旧硬封顶策略缺少单 Run 上限时阻止新色启动，补值后才能完成 init', async () => {
    const policiesTable = `${prefix}_billing_tenant_policies`;
    await pool.query(`
      CREATE TABLE ${policiesTable} (
        tenant_id TEXT PRIMARY KEY,
        policy_version TEXT NOT NULL,
        billing_enabled BOOLEAN NOT NULL DEFAULT false,
        pricing_version TEXT NOT NULL,
        billing_mode TEXT NOT NULL DEFAULT 'prepaid',
        default_target_margin_bps INTEGER NOT NULL,
        organization_multiplier_bps INTEGER NOT NULL DEFAULT 10000,
        allow_negative_balance BOOLEAN NOT NULL DEFAULT false,
        negative_limit_credits_micro BIGINT NOT NULL DEFAULT 0,
        low_balance_threshold_credits_micro BIGINT NOT NULL DEFAULT 0,
        hard_cap_mode TEXT NOT NULL DEFAULT 'none',
        show_balance BOOLEAN NOT NULL DEFAULT true,
        show_usage_credits BOOLEAN NOT NULL DEFAULT true,
        show_cost BOOLEAN NOT NULL DEFAULT false,
        show_gross_margin BOOLEAN NOT NULL DEFAULT false,
        updated_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
    await pool.query(`
      INSERT INTO ${policiesTable}
        (tenant_id, policy_version, billing_enabled, pricing_version, billing_mode,
         default_target_margin_bps, hard_cap_mode, updated_by, updated_at)
      VALUES ('legacy-tenant', 'legacy-v1', true, 'price-v1', 'prepaid', 6000,
              'stop_before_run', 'legacy-admin', NOW())
    `);

    const store = new PgBillingStore({ pool, tablePrefix: prefix });
    await expect(store.init()).rejects.toThrow(
      'hard-capped tenants missing max_run_credits_micro (legacy-tenant)',
    );

    const migrated = await pool.query<{ max_run_credits_micro: string | null }>(
      `SELECT max_run_credits_micro FROM ${policiesTable} WHERE tenant_id = 'legacy-tenant'`,
    );
    expect(migrated.rows[0]?.max_run_credits_micro).toBeNull();

    await pool.query(
      `UPDATE ${policiesTable} SET max_run_credits_micro = $1 WHERE tenant_id = 'legacy-tenant'`,
      [100 * CREDIT_MICRO],
    );
    await expect(store.init()).resolves.toBeUndefined();

    await store.adjustAccount({
      tenantId: 'legacy-tenant',
      type: 'grant',
      creditsDeltaMicro: 500 * CREDIT_MICRO,
      actor: 'test',
      idempotencyKey: 'date-contract-grant',
    });
    const reservation = await store.ensureRunReservation({
      tenantId: 'legacy-tenant',
      userId: 'user-1',
      username: 'tester',
      runId: 'date-contract-run',
      sessionId: 'date-contract-session',
      now: new Date('2026-08-08T04:00:00.000Z'),
    });
    expect(reservation).toMatchObject({
      ok: true,
      value: { periodStart: '2026-08-01', status: 'active' },
    });
    await expect(store.settleRunDebit('legacy-tenant', 'date-contract-run')).resolves.toBeNull();
    const settled = await pool.query<{ status: string; period_start: string }>(`
      SELECT status, to_char(period_start, 'YYYY-MM-DD') AS period_start
      FROM ${prefix}_billing_run_reservations
      WHERE tenant_id = 'legacy-tenant' AND run_id = 'date-contract-run'
    `);
    expect(settled.rows[0]).toEqual({ status: 'settled', period_start: '2026-08-01' });
  }, 30_000);
});
