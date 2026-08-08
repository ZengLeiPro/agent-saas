import { describe, expect, it } from 'vitest';

import {
  RUN_RESERVATION_CHUNK_CREDITS_MICRO,
  committedMemberBudgetCreditsMicro,
  extendRunReservationLocked,
  initialRunReservationGrant,
  planRunReservationExtension,
} from '../data/billing/runReservationPolicy.js';
import { CREDIT_MICRO, type TenantBillingPolicy } from '../data/billing/types.js';

describe('Run 分段预占策略', () => {
  it('大额单 Run 上限只建立一个小额启动窗口', () => {
    expect(initialRunReservationGrant([300_000 * CREDIT_MICRO, 99_999 * CREDIT_MICRO]))
      .toBe(RUN_RESERVATION_CHUNK_CREDITS_MICRO);
  });

  it('组织余额或个人额度小于窗口时只预占真实可用值', () => {
    expect(initialRunReservationGrant([40 * CREDIT_MICRO, 50 * CREDIT_MICRO]))
      .toBe(40 * CREDIT_MICRO);
  });

  it('模型调用允许部分补占，固定费用要求完整补占', () => {
    const caps = [
      { value: 60 * CREDIT_MICRO, code: 'BILLING_ORG_BALANCE_EXHAUSTED' as const },
      { value: 200 * CREDIT_MICRO, code: 'BILLING_RUN_LIMIT_EXCEEDED' as const },
    ];

    expect(planRunReservationExtension(100 * CREDIT_MICRO, caps, false)).toEqual({
      addedCreditsMicro: 60 * CREDIT_MICRO,
      limitingCode: 'BILLING_ORG_BALANCE_EXHAUSTED',
    });
    expect(planRunReservationExtension(100 * CREDIT_MICRO, caps, true)).toEqual({
      addedCreditsMicro: 0,
      limitingCode: 'BILLING_ORG_BALANCE_EXHAUSTED',
    });
  });

  it('补占在同一事务内同步更新组织账户与 Run 窗口', async () => {
    const updates: string[] = [];
    const client = {
      query: async <T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> => {
        updates.push(sql);
        const rows = sql.includes('RETURNING 1 AS updated') ? [{ updated: 1 }] : [];
        return { rows: rows as T[] };
      },
    };
    const policy = {
      hardCapMode: 'stop_before_run', maxRunCreditsMicro: 500 * CREDIT_MICRO,
      allowNegativeBalance: false, negativeLimitCreditsMicro: 0,
    } as TenantBillingPolicy;
    const reservation = {
      tenantId: 'tenant-a', runId: 'run-a', periodStart: '2026-08-01',
      grantedCreditsMicro: 100 * CREDIT_MICRO,
      remainingCreditsMicro: 100 * CREDIT_MICRO,
      status: 'active' as const,
      createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z',
    };

    const result = await extendRunReservationLocked({
      client,
      tables: {
        creditAccountsTable: 'credit_accounts', creditLedgerTable: 'credit_ledger',
        memberBudgetsTable: 'member_budgets', memberPeriodAccountsTable: 'member_period_accounts',
        runReservationsTable: 'run_reservations',
      },
      account: {
        tenantId: 'tenant-a', balanceCreditsMicro: 1_000 * CREDIT_MICRO,
        reservedCreditsMicro: 100 * CREDIT_MICRO, updatedAt: '2026-08-08T00:00:00.000Z',
      },
      policy,
      reservation,
      requestedCreditsMicro: 150 * CREDIT_MICRO,
      requireFullExtension: true,
    });

    expect(result.reservation).toMatchObject({
      grantedCreditsMicro: 250 * CREDIT_MICRO,
      remainingCreditsMicro: 250 * CREDIT_MICRO,
    });
    expect(updates).toHaveLength(2);
  });
});

describe('员工软预算口径', () => {
  it('仅提醒只按已结算用量判断，强制模式才计入在途预占', () => {
    expect(committedMemberBudgetCreditsMicro(1_000, 900, 'notify')).toBe(1_000);
    expect(committedMemberBudgetCreditsMicro(1_000, 900, 'stop_new_runs')).toBe(1_900);
  });
});
