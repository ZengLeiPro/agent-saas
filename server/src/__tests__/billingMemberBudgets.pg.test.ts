import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import { PgBillingStore } from '../data/billing/pgBillingStore.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('Billing member budget PostgreSQL 真实聚合', () => {
  const prefix = `billing_member_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgBillingStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    store = new PgBillingStore({ pool, tablePrefix: prefix });
    await store.init();

    await pool.query(`
      INSERT INTO ${store.memberBudgetsTable}
        (tenant_id, user_id, monthly_limit_micro, active, version, created_by, created_at, updated_by, updated_at)
      VALUES
        ('tenant-a', 'user-1', 1000000, true, 1, 'test', NOW(), 'test', NOW()),
        ('tenant-a', 'user-2', 2000000, true, 1, 'test', NOW(), 'test', NOW())
    `);

    const insertLedger = async (input: {
      id: string; userId?: string; type: 'debit' | 'refund'; delta: number; createdAt: string; reversesId?: string;
    }) => pool.query(`
      INSERT INTO ${store.creditLedgerTable}
        (id, idempotency_key, tenant_id, account_id, type, source, related_usage_event_ids,
         user_id, reverses_ledger_id, credits_delta_micro, balance_before_micro, balance_after_micro,
         credit_value_yuan_micro, revenue_yuan_micro, actual_cost_yuan_micro, gross_profit_yuan_micro,
         pricing_version, billing_policy_version, created_at)
      VALUES ($1, $2, 'tenant-a', 'tenant-a', $3, 'usage', ARRAY[]::TEXT[], $4, $5, $6,
              0, 0, 1000000, 0, 0, 0, 'test-pricing', 'test-policy', $7)
    `, [input.id, `idem:${input.id}`, input.type, input.userId ?? null, input.reversesId ?? null, input.delta, input.createdAt]);

    await insertLedger({ id: 'u1-debit', userId: 'user-1', type: 'debit', delta: -125, createdAt: '2026-08-03T00:00:00.000Z' });
    await insertLedger({ id: 'u1-refund', userId: 'user-1', type: 'refund', delta: 25, reversesId: 'u1-debit', createdAt: '2026-09-02T00:00:00.000Z' });
    await insertLedger({ id: 'u2-debit', userId: 'user-2', type: 'debit', delta: -300, createdAt: '2026-08-04T00:00:00.000Z' });
    await insertLedger({ id: 'unattributed-debit', type: 'debit', delta: -50, createdAt: '2026-08-05T00:00:00.000Z' });
  }, 30_000);

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

  it('userId 作用域只聚合该成员，并按原始扣费日期计入跨月退款', async () => {
    const overview = await store.getMemberBudgetOverview(
      'tenant-a',
      'user-1',
      new Date('2026-08-15T00:00:00+08:00'),
    );

    expect(overview.items).toHaveLength(1);
    expect(overview.items[0]).toMatchObject({
      userId: 'user-1',
      monthUsedCreditsMicro: 100,
    });
    expect(overview.monthUsedCreditsMicro).toBe(100);
    expect(overview.unattributedCreditsMicro).toBe(0);
  });

  it('组织作用域保留成员总量与组织未归属用量', async () => {
    const overview = await store.getMemberBudgetOverview(
      'tenant-a',
      undefined,
      new Date('2026-08-15T00:00:00+08:00'),
    );

    expect(overview.monthUsedCreditsMicro).toBe(450);
    expect(overview.unattributedCreditsMicro).toBe(50);
    expect(new Map(overview.items.map((item) => [item.userId, item.monthUsedCreditsMicro])))
      .toEqual(new Map([['user-1', 100], ['user-2', 300]]));
  });
});
