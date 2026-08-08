import { describe, expect, it } from 'vitest';

import {
  availableOrganizationCreditsMicro,
  evaluateRunAllowance,
} from '../data/billing/runAllowancePolicy.js';
import { CREDIT_MICRO, type TenantBillingPolicy } from '../data/billing/types.js';

function policy(overrides: Partial<TenantBillingPolicy> = {}): TenantBillingPolicy {
  return {
    tenantId: 'tenant-a', policyVersion: 'v1', billingEnabled: true,
    pricingVersion: 'price-v1', billingMode: 'prepaid', defaultTargetMarginBps: 6000,
    organizationMultiplierBps: 10_000, allowNegativeBalance: false,
    negativeLimitCreditsMicro: 0, lowBalanceThresholdCreditsMicro: 0,
    hardCapMode: 'stop_before_run', maxRunCreditsMicro: 1_000 * CREDIT_MICRO,
    showBalance: true, showUsageCredits: true, showCost: false, showGrossMargin: false,
    updatedBy: 'test', updatedAt: '2026-08-08T00:00:00.000Z',
    ...overrides,
  };
}

const account = {
  tenantId: 'tenant-a', balanceCreditsMicro: 100 * CREDIT_MICRO,
  updatedAt: '2026-08-08T00:00:00.000Z',
};

describe('Run 实际用量门禁', () => {
  it('组织余额不再扣除任何在途预占', () => {
    expect(availableOrganizationCreditsMicro(account, policy())).toBe(100 * CREDIT_MICRO);
    expect(availableOrganizationCreditsMicro(account, policy({
      allowNegativeBalance: true,
      negativeLimitCreditsMicro: 10 * CREDIT_MICRO,
    }))).toBe(110 * CREDIT_MICRO);
  });

  it('未超额时放行下一次调用，达到实际累计上限后停止', () => {
    expect(evaluateRunAllowance({
      account, policy: policy({ maxRunCreditsMicro: 80 * CREDIT_MICRO }),
      runUsedCreditsMicro: 79 * CREDIT_MICRO,
    })).toEqual({ ok: true });
    expect(evaluateRunAllowance({
      account, policy: policy({ maxRunCreditsMicro: 80 * CREDIT_MICRO }),
      runUsedCreditsMicro: 80 * CREDIT_MICRO,
    })).toMatchObject({ ok: false, code: 'BILLING_RUN_LIMIT_EXCEEDED' });
  });

  it('允许并发在途调用基于同一快照通过，但实际扣成负数后停止下一动作', () => {
    const beforeDebit = {
      account: { ...account, balanceCreditsMicro: 10 * CREDIT_MICRO },
      policy: policy(),
      runUsedCreditsMicro: 0,
    };
    expect(evaluateRunAllowance(beforeDebit)).toEqual({ ok: true });
    expect(evaluateRunAllowance(beforeDebit)).toEqual({ ok: true });
    expect(evaluateRunAllowance({
      ...beforeDebit,
      account: { ...account, balanceCreditsMicro: -5 * CREDIT_MICRO },
      runUsedCreditsMicro: 15 * CREDIT_MICRO,
    })).toMatchObject({ ok: false, code: 'BILLING_ORG_BALANCE_EXHAUSTED' });
  });

  it('固定费用按即将发生的精确金额预检', () => {
    expect(evaluateRunAllowance({
      account, policy: policy(), runUsedCreditsMicro: 90 * CREDIT_MICRO,
      prospectiveCreditsMicro: 20 * CREDIT_MICRO,
    })).toEqual({ ok: true });
    expect(evaluateRunAllowance({
      account, policy: policy(), runUsedCreditsMicro: 90 * CREDIT_MICRO,
      prospectiveCreditsMicro: 110 * CREDIT_MICRO,
    })).toMatchObject({ ok: false, code: 'BILLING_ORG_BALANCE_EXHAUSTED' });
  });

  it('强制模式只检查已配置的员工额度，未配置的可选上限不误伤', () => {
    expect(evaluateRunAllowance({
      account, policy: policy(), runUsedCreditsMicro: 40 * CREDIT_MICRO,
      member: {
        active: true,
        enforcementMode: 'stop_new_runs',
        monthUsedCreditsMicro: 90 * CREDIT_MICRO,
        monthlyLimitCreditsMicro: 100 * CREDIT_MICRO,
      },
    })).toEqual({ ok: true });
    expect(evaluateRunAllowance({
      account, policy: policy(), runUsedCreditsMicro: 40 * CREDIT_MICRO,
      member: {
        active: true,
        enforcementMode: 'stop_new_runs',
        monthUsedCreditsMicro: 90 * CREDIT_MICRO,
        perRunLimitCreditsMicro: 50 * CREDIT_MICRO,
      },
    })).toEqual({ ok: true });
  });

  it('仅提醒忽略个人额度，强制模式按实际月用量和 Run 用量拦截', () => {
    const baseMember = {
      active: true, monthUsedCreditsMicro: 90 * CREDIT_MICRO,
      monthlyLimitCreditsMicro: 100 * CREDIT_MICRO,
      perRunLimitCreditsMicro: 50 * CREDIT_MICRO,
    };
    expect(evaluateRunAllowance({
      account, policy: policy(), runUsedCreditsMicro: 49 * CREDIT_MICRO,
      member: { ...baseMember, enforcementMode: 'notify' },
    })).toEqual({ ok: true });
    expect(evaluateRunAllowance({
      account, policy: policy(), runUsedCreditsMicro: 50 * CREDIT_MICRO,
      member: { ...baseMember, enforcementMode: 'stop_new_runs' },
    })).toMatchObject({ ok: false, code: 'BILLING_MEMBER_PER_RUN_LIMIT_EXCEEDED' });
    expect(evaluateRunAllowance({
      account, policy: policy(), runUsedCreditsMicro: 10 * CREDIT_MICRO,
      prospectiveCreditsMicro: 11 * CREDIT_MICRO,
      member: { ...baseMember, enforcementMode: 'stop_new_runs' },
    })).toMatchObject({ ok: false, code: 'BILLING_MEMBER_MONTHLY_LIMIT_EXCEEDED' });
  });
});
