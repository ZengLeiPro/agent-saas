import { describe, expect, it } from 'vitest';
import {
  billingAllowanceLabel,
  billingModeLabel,
  budgetBarRatio,
  budgetStatusLabel,
  formatBillingCredits,
  formatBillingCreditsDetailed,
  formatBudgetUsageRatio,
  isBillingBadgeVisible,
  resolveBillingAllowance,
  resolveBillingBadgeTone,
} from './billingBadge';

const enabled = { balanceCredits: 120, billingEnabled: true, billingMode: 'prepaid' };

describe('billingBadge', () => {
  it('有个人月度额度时用个人剩余，否则回落组织池', () => {
    expect(
      resolveBillingAllowance(enabled, { monthlyLimitCredits: 500, remainingCredits: 80 }),
    ).toEqual({ credits: 80, source: 'member' });
    expect(
      resolveBillingAllowance(enabled, { monthlyLimitCredits: null, remainingCredits: 80 }),
    ).toEqual({ credits: 120, source: 'tenant' });
    expect(resolveBillingAllowance(enabled, null)).toEqual({ credits: 120, source: 'tenant' });
  });

  it('计费关闭或 internal 模式隐藏徽标', () => {
    expect(isBillingBadgeVisible(enabled)).toBe(true);
    expect(isBillingBadgeVisible(null)).toBe(false);
    expect(isBillingBadgeVisible({ ...enabled, billingEnabled: false })).toBe(false);
    expect(isBillingBadgeVisible({ ...enabled, billingMode: 'internal' })).toBe(false);
  });

  it('额度来源与计费模式文案', () => {
    expect(billingAllowanceLabel('member')).toBe('个人剩余额度');
    expect(billingAllowanceLabel('tenant')).toBe('组织可用积分');
    expect(billingModeLabel('postpaid')).toBe('后付费');
    expect(billingModeLabel('')).toBe('未配置');
    expect(billingModeLabel('weird')).toBe('weird');
  });

  it('预算状态文案与告警等级', () => {
    expect(budgetStatusLabel('over')).toBe('已超预算');
    expect(budgetStatusLabel('unset')).toBe('未设置');
    expect(resolveBillingBadgeTone(false, 'normal')).toBe('none');
    expect(resolveBillingBadgeTone(false, 'warning')).toBe('warn');
    expect(resolveBillingBadgeTone(false, 'over')).toBe('danger');
    expect(resolveBillingBadgeTone(true, 'normal')).toBe('danger');
    expect(resolveBillingBadgeTone(false, 'normal', true)).toBe('danger');
  });

  it('进度条比例钳在 0~1，缺数据为 0', () => {
    expect(budgetBarRatio(null)).toBe(0);
    expect(budgetBarRatio(Number.NaN)).toBe(0);
    expect(budgetBarRatio(-100)).toBe(0);
    expect(budgetBarRatio(2_500)).toBeCloseTo(0.25);
    expect(budgetBarRatio(20_000)).toBe(1);
  });

  it('使用率文案按万分比换算', () => {
    expect(formatBudgetUsageRatio(null)).toBe('-');
    expect(formatBudgetUsageRatio(1_234)).toBe('12.3%');
    expect(formatBudgetUsageRatio(5_000)).toBe('50%');
  });

  it('紧凑积分：万位折算、百位取整、小额两位小数', () => {
    expect(formatBillingCredits(Number.NaN)).toBe('0');
    expect(formatBillingCredits(12_345)).toBe('1.2万');
    expect(formatBillingCredits(1_234.6)).toBe('1,235');
    expect(formatBillingCredits(12.345)).toBe('12.35');
    expect(formatBillingCredits(12)).toBe('12');
    expect(formatBillingCredits(-12_345)).toBe('-1.2万');
  });

  it('明细积分不折算万，最多两位小数', () => {
    expect(formatBillingCreditsDetailed(12_345.678)).toBe('12,345.68');
    expect(formatBillingCreditsDetailed(1_000)).toBe('1,000');
    expect(formatBillingCreditsDetailed(Number.POSITIVE_INFINITY)).toBe('0');
  });
});
