export interface UsageOverview {
  currentMonthCreditsUsed: number;
  balanceCredits: number;
  estimatedDaysRemaining: number | null;
  topUsers: Array<{ userId: string; name: string; creditsUsed: number }>;
  topCapabilities: Array<{ capabilityId: string; calls: number }>;
  weeklyTrend: Array<{ date: string; creditsUsed: number }>;
  capabilityMetric: 'call_count';
}

/** Validate the fields the view consumes; missing metrics must not become fake zeros. */
export function isUsageOverview(value: unknown): value is UsageOverview {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<UsageOverview>;
  return (
    Number.isFinite(data.currentMonthCreditsUsed) &&
    Number.isFinite(data.balanceCredits) &&
    (data.estimatedDaysRemaining === null || Number.isFinite(data.estimatedDaysRemaining)) &&
    data.capabilityMetric === 'call_count' &&
    Array.isArray(data.topUsers) &&
    data.topUsers.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.userId === 'string' &&
        typeof item.name === 'string' &&
        Number.isFinite(item.creditsUsed),
    ) &&
    Array.isArray(data.topCapabilities) &&
    data.topCapabilities.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.capabilityId === 'string' &&
        Number.isFinite(item.calls),
    ) &&
    Array.isArray(data.weeklyTrend) &&
    data.weeklyTrend.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.date === 'string' &&
        Number.isFinite(item.creditsUsed),
    )
  );
}
