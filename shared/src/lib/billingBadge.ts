/**
 * 积分徽标（BillingMiniBadge）的纯展示逻辑。
 *
 * Web 把这些规则写死在 `web/src/components/BillingMiniBadge.tsx` 与
 * `web/src/hooks/useTenantBillingVisibility.ts` 组件内部；移动端要复用同一套
 * 可见性 / 额度口径 / 文案，所以下沉到 shared。这里只做纯计算，不发请求。
 */

export interface TenantBillingSummary {
  balanceCredits: number;
  billingEnabled: boolean;
  billingMode: string;
}

/** 账号维度汇总（`GET /api/billing/me/summary` 的 summary 字段）。 */
export interface BillingAccountSummary extends TenantBillingSummary {
  lowBalance: boolean;
  currentMonthCreditsUsed: number;
  currentMonthRevenueYuan: number;
}

/** 会话维度汇总（`GET /api/billing/sessions/:id/summary` 的 summary 字段）。 */
export interface SessionBillingSummary {
  sessionId: string;
  creditsUsed: number;
  revenueYuan: number;
  childSessionCount?: number;
}

export type MemberBudgetStatus = 'unset' | 'normal' | 'attention' | 'warning' | 'over';

/** 个人预算（`GET /api/billing/me/budget` 的 budget 字段）。 */
export interface MyMemberBudget {
  monthlyLimitCredits: number | null;
  remainingCredits: number | null;
  monthUsedCredits: number;
  canStartRun: boolean;
  usageRatioBps: number | null;
  status: MemberBudgetStatus;
}

export interface BillingAllowance {
  credits: number;
  source: 'member' | 'tenant';
}

export type BillingBadgeTone = 'none' | 'warn' | 'danger';

/** 有个人月度额度时以个人剩余为准，否则回落组织池余额。 */
export function resolveBillingAllowance(
  summary: TenantBillingSummary,
  budget: Pick<MyMemberBudget, 'monthlyLimitCredits' | 'remainingCredits'> | null,
): BillingAllowance {
  if (budget && budget.monthlyLimitCredits !== null && budget.remainingCredits !== null) {
    return { credits: budget.remainingCredits, source: 'member' };
  }
  return { credits: summary.balanceCredits, source: 'tenant' };
}

/** 计费未开启或 internal 模式时整个徽标隐藏（与 Web 的早退分支一致）。 */
export function isBillingBadgeVisible(summary: TenantBillingSummary | null | undefined): boolean {
  if (!summary) return false;
  return summary.billingEnabled === true && summary.billingMode !== 'internal';
}

export function billingAllowanceLabel(source: BillingAllowance['source']): string {
  return source === 'member' ? '个人剩余额度' : '组织可用积分';
}

export function billingModeLabel(mode: string): string {
  switch (mode) {
    case 'prepaid':
      return '预付费';
    case 'postpaid':
      return '后付费';
    case 'trial':
      return '试用';
    case 'internal':
      return '内部';
    default:
      return mode || '未配置';
  }
}

export function budgetStatusLabel(status: MemberBudgetStatus): string {
  if (status === 'over') return '已超预算';
  if (status === 'warning') return '临近预算';
  if (status === 'attention') return '需要关注';
  if (status === 'normal') return '正常';
  return '未设置';
}

/**
 * 触发按钮告警等级：余额不足 / 已停发 / 超预算 = danger，临近预算 = warn，其余无色。
 * 颜色只承载状态，常态下与右上角其他 ghost 控件同重量。
 */
export function resolveBillingBadgeTone(
  lowBalance: boolean,
  status: MemberBudgetStatus | undefined,
  blocked = false,
): BillingBadgeTone {
  if (lowBalance || blocked || status === 'over') return 'danger';
  if (status === 'warning') return 'warn';
  return 'none';
}

/** 预算进度条填充比例，钳在 0~1；bps 为万分比。 */
export function budgetBarRatio(usageRatioBps: number | null): number {
  if (usageRatioBps === null || !Number.isFinite(usageRatioBps)) return 0;
  return Math.min(1, Math.max(0, usageRatioBps / 10_000));
}

/** 万分比 → 百分比文案；缺数据显示 "-"。 */
export function formatBudgetUsageRatio(usageRatioBps: number | null): string {
  if (usageRatioBps === null || !Number.isFinite(usageRatioBps)) return '-';
  return `${trimZeros((usageRatioBps / 100).toFixed(1))}%`;
}

function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/u, '') : value;
}

/** 千分位分组；不依赖 Intl，Hermes 与 Node 输出一致。 */
function groupThousands(value: string): string {
  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;
  const [intPart, fracPart] = body.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  return `${negative ? '-' : ''}${grouped}${fracPart ? `.${fracPart}` : ''}`;
}

/** 胶囊上的紧凑积分：万位折算「万」，百位以上取整，小额保留两位小数。 */
export function formatBillingCredits(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  if (Math.abs(value) >= 100) return groupThousands(Math.round(value).toString());
  return groupThousands(trimZeros(value.toFixed(2)));
}

/** 明细面板上的完整积分：最多两位小数，不折算万。 */
export function formatBillingCreditsDetailed(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return groupThousands(trimZeros(value.toFixed(2)));
}
