import { describe, expect, it, vi } from 'vitest';

import { PgBillingStore } from '../data/billing/pgBillingStore.js';

function normalized(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('reversal 财务汇总查询', () => {
  it('月度、日报和审计按原 debit 日期归集 reversal，成本不冲回', async () => {
    const sqls: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        sqls.push(normalized(sql));
        if (/GROUP BY day/.test(sql)) {
          return { rows: [{
            day: '2026-07-31',
            actual_cost_yuan_micro: '300',
            revenue_yuan_micro: '0',
            credits_charged_micro: '0',
            gross_profit_yuan_micro: '-300',
          }] };
        }
        if (/AS credits_used_micro/.test(sql)) {
          return { rows: [{
            credits_used_micro: '0',
            revenue_yuan_micro: '0',
            actual_cost_yuan_micro: '300',
            gross_profit_yuan_micro: '-300',
          }] };
        }
        if (/COUNT\(\*\) AS count/.test(sql)) return { rows: [{ count: '0' }] };
        if (/billing_credit_accounts/.test(sql)) return { rows: [] };
        if (/AS credits_charged_micro/.test(sql)) {
          return { rows: [{
            actual_cost_yuan_micro: '300',
            revenue_yuan_micro: '0',
            credits_charged_micro: '0',
            gross_profit_yuan_micro: '-300',
          }] };
        }
        throw new Error(`unexpected SQL: ${normalized(sql).slice(0, 160)}`);
      }),
    };
    const store = new PgBillingStore({ pool: pool as any });

    await expect(store.getMonthlyLedgerSummary('tenant-a', '2026-07-01T00:00:00.000Z')).resolves.toMatchObject({
      creditsUsedMicro: 0,
      revenueYuanMicro: 0,
      actualCostYuanMicro: 300,
      grossProfitYuanMicro: -300,
    });
    await expect(store.getDailyAuditBreakdown({ tenantId: 'tenant-a', days: 30 })).resolves.toEqual([expect.objectContaining({
      date: '2026-07-31',
      creditsChargedMicro: 0,
      revenueYuanMicro: 0,
      actualCostYuanMicro: 300,
    })]);
    await expect(store.getAuditSummary({ tenantId: 'tenant-a', days: 30 })).resolves.toMatchObject({
      creditsChargedMicro: 0,
      revenueYuanMicro: 0,
      actualCostYuanMicro: 300,
      grossProfitYuanMicro: -300,
    });

    const monthly = sqls.find((sql) => /AS credits_used_micro/.test(sql))!;
    const daily = sqls.find((sql) => /GROUP BY day/.test(sql))!;
    const audit = sqls.find((sql) => /AS credits_charged_micro/.test(sql) && !/GROUP BY day/.test(sql))!;
    for (const sql of [monthly, daily, audit]) {
      expect(sql).toMatch(/LEFT JOIN .* original ON original\.id = l\.reverses_ledger_id/);
      expect(sql).toContain('COALESCE(original.created_at, l.created_at)');
      expect(sql).toContain("type IN ('debit','reversal')");
      expect(sql).toMatch(/CASE WHEN type\s*=\s*'debit' THEN actual_cost_yuan_micro/);
    }
  });

  it('会话树账单净掉 reversal，但保留已发生的模型成本', async () => {
    let capturedSql = '';
    const pool = {
      query: vi.fn(async (sql: string) => {
        capturedSql = normalized(sql);
        return { rows: [{
          credits_used_micro: '0',
          revenue_yuan_micro: '0',
          actual_cost_yuan_micro: '300',
          child_session_count: '2',
        }] };
      }),
    };
    const store = new PgBillingStore({ pool: pool as any });

    await expect(store.getSessionTreeLedgerSummary('tenant-a', 'session-1')).resolves.toEqual({
      creditsUsedMicro: 0,
      revenueYuanMicro: 0,
      actualCostYuanMicro: 300,
      childSessionCount: 2,
    });
    expect(capturedSql).toContain("l.type IN ('debit','reversal')");
    expect(capturedSql).toContain("l.type = 'debit' THEN l.actual_cost_yuan_micro");
  });
});
