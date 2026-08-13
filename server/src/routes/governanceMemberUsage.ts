import type { BillingMemberBudgetOverview } from '../data/billing/types.js';

export async function getGovernanceMemberUsagePolicy(
  getOverview: ((tenantId: string, userId: string) => Promise<BillingMemberBudgetOverview>) | undefined,
  tenantId: string,
  userId: string,
): Promise<unknown> {
  if (!getOverview) return { status: 'unavailable' as const };
  return getOverview(tenantId, userId)
    .then(overview => ({
      tenantId: overview.tenantId,
      timezone: overview.timezone,
      periodStart: overview.periodStart,
      periodEnd: overview.periodEnd,
      // 成员详情 API 只暴露该成员的已归属用量；组织总用量和未归属用量不属于成员口径。
      items: overview.items.map(({ monthUsedCreditsMicro, ...item }) => ({
        ...item,
        monthAttributedCreditsMicro: monthUsedCreditsMicro,
      })),
    }))
    .catch(() => ({ status: 'unavailable' as const }));
}
