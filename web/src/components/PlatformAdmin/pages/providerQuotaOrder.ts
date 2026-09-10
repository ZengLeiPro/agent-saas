import type { ProviderQuotaSnapshot } from '@agent/shared';

export const PROVIDER_QUOTA_ORDER_STORAGE_KEY = 'platform-console.provider-quota.account-order.v1';

const SOURCE_ORDER: Record<ProviderQuotaSnapshot['sourceKind'], number> = {
  codex_subscription: 0,
  claude_subscription: 1,
  volcengine_ark_plan: 2,
};

/** 浏览器偏好损坏或存储被禁用时，仍可正常查看和调整卡片。 */
export function readQuotaAccountOrder(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(PROVIDER_QUOTA_ORDER_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((key): key is string => typeof key === 'string' && key.length > 0))];
  } catch {
    return [];
  }
}

export function writeQuotaAccountOrder(order: readonly string[]): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(PROVIDER_QUOTA_ORDER_STORAGE_KEY, JSON.stringify(order));
    return true;
  } catch {
    return false;
  }
}

/** 保留手动顺序；失效账号不渲染，新增账号按默认供应商顺序追加，不修改接口数据。 */
export function orderQuotaAccounts(
  items: readonly ProviderQuotaSnapshot[],
  order: readonly string[],
): ProviderQuotaSnapshot[] {
  const positions = new Map(order.map((key, index) => [key, index]));
  return [...items].sort((a, b) => {
    const aPosition = positions.get(a.accountKey);
    const bPosition = positions.get(b.accountKey);
    if (aPosition !== undefined && bPosition !== undefined) return aPosition - bPosition;
    if (aPosition !== undefined) return -1;
    if (bPosition !== undefined) return 1;
    return (SOURCE_ORDER[a.sourceKind] ?? 3) - (SOURCE_ORDER[b.sourceKind] ?? 3);
  });
}

/** 拖放与键盘共用的移动操作；取消、原位放下或失效目标不产生写入。 */
export function moveQuotaAccount(
  order: readonly string[],
  accountKey: string,
  targetKey: string,
): string[] | null {
  const from = order.indexOf(accountKey);
  const to = order.indexOf(targetKey);
  if (from < 0 || to < 0 || from === to) return null;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, accountKey);
  return next;
}
