import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  BillingBudgetIdempotencyConflictError,
  BillingBudgetVersionConflictError,
  PgBillingStore,
} from '../data/billing/pgBillingStore.js';

function overviewQueries() {
  return vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('WITH budgets AS')) {
      return {
        rows: [{
          user_id: 'user-1',
          monthly_limit_micro: '2000000000',
          active: true,
          version: '2',
          month_used_micro: '1250000000',
          last_used_at: '2026-08-01T01:00:00.000Z',
          updated_by: 'admin',
          updated_at: '2026-08-01T00:30:00.000Z',
        }],
      };
    }
    if (sql.includes('unattributed_micro')) {
      return { rows: [{ month_used_micro: '1300000000', unattributed_micro: '50000000' }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
}

describe('PgBillingStore 员工预算', () => {
  it('按北京时间自然月聚合成员用量和未归属用量', async () => {
    const query = overviewQueries();
    const store = new PgBillingStore({ pool: { query } as any });
    const result = await store.getMemberBudgetOverview('wain', undefined, new Date('2026-08-01T02:00:00+08:00'));

    expect(result).toMatchObject({
      tenantId: 'wain',
      timezone: 'Asia/Shanghai',
      periodStart: '2026-07-31T16:00:00.000Z',
      periodEnd: '2026-08-31T16:00:00.000Z',
      monthUsedCreditsMicro: 1_300_000_000,
      unattributedCreditsMicro: 50_000_000,
      items: [{
        userId: 'user-1',
        monthlyLimitCreditsMicro: 2_000_000_000,
        monthUsedCreditsMicro: 1_250_000_000,
        version: 2,
      }],
    });
    expect(query.mock.calls[0]?.[1]).toEqual([
      'wain',
      new Date('2026-07-31T16:00:00.000Z'),
      new Date('2026-08-31T16:00:00.000Z'),
      null,
    ]);
  });

  it('新增预算时执行乐观锁、写审计并返回当前用量', async () => {
    const clientQuery = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('idempotency_key = $2')) return { rows: [] };
      if (sql.includes('FROM') && sql.includes('billing_member_budgets') && sql.includes('FOR UPDATE')) return { rows: [] };
      if (sql.includes('INSERT INTO') && sql.includes('billing_member_budgets')) return { rows: [] };
      if (sql.includes('INSERT INTO') && sql.includes('billing_member_budget_audit')) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });
    const query = overviewQueries();
    const release = vi.fn();
    const store = new PgBillingStore({
      pool: {
        query,
        connect: vi.fn(async () => ({ query: clientQuery, release })),
      } as any,
    });

    const result = await store.upsertMemberBudget({
      tenantId: 'wain',
      userId: 'user-1',
      monthlyLimitCreditsMicro: 2_000_000_000,
      expectedVersion: 0,
      idempotencyKey: 'budget:202608:user-1',
      note: '8 月预算',
      actorUserId: 'admin-1',
      actorUsername: 'admin',
      now: new Date('2026-08-01T00:30:00+08:00'),
    });

    expect(result.replayed).toBe(false);
    expect(result.audit).toMatchObject({
      tenantId: 'wain',
      userId: 'user-1',
      afterLimitCreditsMicro: 2_000_000_000,
      beforeActive: false,
      afterActive: true,
      actorUserId: 'admin-1',
    });
    expect(clientQuery.mock.calls.filter(([sql]) => String(sql).includes('pg_advisory_xact_lock'))).toHaveLength(2);
    const auditInsert = clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO') && String(sql).includes('billing_member_budget_audit'));
    expect(auditInsert?.[1]?.[8]).toBe('2026-08-01');
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('版本冲突时回滚且不写预算', async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('idempotency_key = $2')) return { rows: [] };
      if (sql.includes('billing_member_budgets') && sql.includes('FOR UPDATE')) {
        return { rows: [{ row_json: { version: 3, active: true, monthly_limit_micro: '1000000000' } }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const store = new PgBillingStore({
      pool: { connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })) } as any,
    });

    await expect(store.upsertMemberBudget({
      tenantId: 'wain',
      userId: 'user-1',
      expectedVersion: 2,
      idempotencyKey: 'budget:version-conflict',
      note: '调整预算',
      actorUserId: 'admin-1',
      actorUsername: 'admin',
    })).rejects.toBeInstanceOf(BillingBudgetVersionConflictError);
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('相同幂等键用于不同请求时拒绝并回滚', async () => {
    const fingerprint = createHash('sha256').update(JSON.stringify({
      tenantId: 'wain',
      userId: 'user-1',
      monthlyLimitCreditsMicro: 100,
      note: '原请求',
    })).digest('hex');
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('idempotency_key = $2')) {
        return { rows: [{ request_fingerprint: fingerprint, row_json: {} }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const store = new PgBillingStore({
      pool: { connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })) } as any,
    });

    await expect(store.upsertMemberBudget({
      tenantId: 'wain',
      userId: 'user-1',
      monthlyLimitCreditsMicro: 200,
      expectedVersion: 0,
      idempotencyKey: 'budget:reused-key',
      note: '新请求',
      actorUserId: 'admin-1',
      actorUsername: 'admin',
    })).rejects.toBeInstanceOf(BillingBudgetIdempotencyConflictError);
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('历史归属回填使用 projection state 的真实列并拒绝部分缺失归属', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT 1 FROM')) return { rows: [] };
      if (sql.includes('UPDATE') && sql.includes('credit_ledger')) return { rows: [], rowCount: 3 };
      if (sql.includes('INSERT INTO') && sql.includes('projection_state')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const store = new PgBillingStore({ pool: {} as any });

    await (store as any).backfillLedgerUserAttribution({ query });

    const updateSql = String(query.mock.calls.find(([sql]) => String(sql).includes('credit_ledger'))?.[0]);
    expect(updateSql).toContain('COUNT(usage.user_id) = COUNT(*)');
    expect(updateSql).toContain('cardinality(source.related_usage_event_ids)');
    const markerSql = String(query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO'))?.[0]);
    expect(markerSql).toContain('last_global_sequence');
    expect(markerSql).not.toContain('value_json');
  });

  it('删除租户计费数据时同时清理成员预算和预算审计', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('DELETE FROM')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const store = new PgBillingStore({
      pool: { connect: vi.fn(async () => ({ query, release })) } as any,
    });

    await store.deleteTenantData('wain');

    const deleteSql = query.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes('DELETE FROM'));
    expect(deleteSql[0]).toContain('billing_member_budget_audit');
    expect(deleteSql[1]).toContain('billing_member_budgets');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
