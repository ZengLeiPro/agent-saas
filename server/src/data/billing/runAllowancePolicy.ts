import type {
  BillingCreditAccount,
  BillingDecisionCode,
  BillingMemberBudgetEnforcementMode,
  BillingRunAllowanceDecision,
  TenantBillingPolicy,
} from './types.js';

export interface RunAllowanceSnapshot {
  account: BillingCreditAccount;
  policy: TenantBillingPolicy;
  runUsedCreditsMicro: number;
  prospectiveCreditsMicro?: number;
  member?: {
    active: boolean;
    enforcementMode: BillingMemberBudgetEnforcementMode;
    monthUsedCreditsMicro: number;
    monthlyLimitCreditsMicro?: number;
    perRunLimitCreditsMicro?: number;
  };
}

export function availableOrganizationCreditsMicro(
  account: BillingCreditAccount,
  policy: TenantBillingPolicy,
): number {
  return account.balanceCreditsMicro
    + (policy.allowNegativeBalance ? policy.negativeLimitCreditsMicro : 0);
}

export function evaluateRunAllowance(input: RunAllowanceSnapshot): BillingRunAllowanceDecision {
  const prospective = Math.max(0, Math.trunc(input.prospectiveCreditsMicro ?? 0));
  const minimumRequired = prospective > 0 ? prospective : 1;

  if (input.policy.hardCapMode === 'stop_before_run') {
    const runLimit = input.policy.maxRunCreditsMicro;
    if (runLimit === undefined || runLimit <= 0) {
      return denied(
        'BILLING_RUN_LIMIT_NOT_CONFIGURED',
        '组织已启用积分硬封顶，但尚未配置正数的组织单 Run 上限。',
      );
    }
    if (availableOrganizationCreditsMicro(input.account, input.policy) < minimumRequired) {
      return denied('BILLING_ORG_BALANCE_EXHAUSTED', '组织积分余额不足，已停止后续计费动作。');
    }
    if (limitReached(input.runUsedCreditsMicro, prospective, runLimit)) {
      return denied('BILLING_RUN_LIMIT_EXCEEDED', '该运行已达到组织单 Run 积分上限。');
    }
  }

  const member = input.member;
  if (member?.active && member.enforcementMode === 'stop_new_runs') {
    if (member.monthlyLimitCreditsMicro !== undefined
      && limitReached(member.monthUsedCreditsMicro, prospective, member.monthlyLimitCreditsMicro)) {
      return denied('BILLING_MEMBER_MONTHLY_LIMIT_EXCEEDED', '员工本月积分额度已用尽。');
    }
    if (member.perRunLimitCreditsMicro !== undefined
      && limitReached(input.runUsedCreditsMicro, prospective, member.perRunLimitCreditsMicro)) {
      return denied('BILLING_MEMBER_PER_RUN_LIMIT_EXCEEDED', '该运行已达到员工单 Run 积分上限。');
    }
  }

  return { ok: true };
}

function limitReached(current: number, prospective: number, limit: number): boolean {
  return prospective > 0 ? current + prospective > limit : current >= limit;
}

function denied(code: BillingDecisionCode, reason: string): BillingRunAllowanceDecision {
  return { ok: false, code, reason };
}
