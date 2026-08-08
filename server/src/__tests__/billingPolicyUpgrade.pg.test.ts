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

  it('旧硬封顶策略缺少单 Run 上限时阻止启动，补值后才能完成 init', async () => {
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
    await expect(store.authorizeRun({
      tenantId: 'legacy-tenant',
      userId: 'user-1',
      runId: 'allowance-run',
      now: new Date('2026-08-08T04:00:00.000Z'),
    })).resolves.toEqual({ ok: true });
  }, 30_000);

  it('启动时清零旧预占并释放遗留 reservation / hold，新库不创建旧表', async () => {
    const legacyPrefix = `${prefix}_legacy`;
    const store = new PgBillingStore({ pool, tablePrefix: legacyPrefix });
    await store.init();

    const oldReservations = `${legacyPrefix}_billing_run_reservations`;
    const oldHolds = `${legacyPrefix}_billing_run_fixed_fee_holds`;
    const absent = await pool.query<{ reservations: string | null; holds: string | null }>(
      'SELECT to_regclass($1) AS reservations, to_regclass($2) AS holds',
      [oldReservations, oldHolds],
    );
    expect(absent.rows[0]).toEqual({ reservations: null, holds: null });
    await pool.query(`
      INSERT INTO ${legacyPrefix}_billing_credit_accounts
        (tenant_id, balance_micro, reserved_micro, updated_at)
      VALUES ('tenant-a', 1000000000, 800000000, NOW())
    `);
    await pool.query(`
      INSERT INTO ${legacyPrefix}_billing_member_period_accounts
        (tenant_id, user_id, period_start, used_micro, reserved_micro, updated_at)
      VALUES ('tenant-a', 'user-a', CURRENT_DATE, 100000000, 300000000, NOW())
    `);
    await pool.query(`CREATE TABLE ${oldReservations} (
      tenant_id TEXT, run_id TEXT, remaining_micro BIGINT, status TEXT,
      updated_at TIMESTAMPTZ, released_at TIMESTAMPTZ
    )`);
    await pool.query(`CREATE TABLE ${oldHolds} (
      tenant_id TEXT, run_id TEXT, hold_key TEXT, status TEXT, updated_at TIMESTAMPTZ
    )`);
    await pool.query(`INSERT INTO ${oldReservations}
      VALUES ('tenant-a', 'run-a', 800000000, 'active', NOW(), NULL)`);
    await pool.query(`INSERT INTO ${oldHolds}
      VALUES ('tenant-a', 'run-a', 'hold-a', 'active', NOW())`);

    await store.init();

    const account = await pool.query<{ reserved_micro: string }>(
      `SELECT reserved_micro FROM ${legacyPrefix}_billing_credit_accounts WHERE tenant_id = 'tenant-a'`,
    );
    const period = await pool.query<{ reserved_micro: string }>(
      `SELECT reserved_micro FROM ${legacyPrefix}_billing_member_period_accounts WHERE tenant_id = 'tenant-a'`,
    );
    const reservation = await pool.query<{ remaining_micro: string; status: string }>(
      `SELECT remaining_micro, status FROM ${oldReservations} WHERE run_id = 'run-a'`,
    );
    const hold = await pool.query<{ status: string }>(
      `SELECT status FROM ${oldHolds} WHERE hold_key = 'hold-a'`,
    );
    expect(account.rows[0]).toEqual({ reserved_micro: '0' });
    expect(period.rows[0]).toEqual({ reserved_micro: '0' });
    expect(reservation.rows[0]).toEqual({ remaining_micro: '0', status: 'released' });
    expect(hold.rows[0]).toEqual({ status: 'released' });
  }, 30_000);
});
