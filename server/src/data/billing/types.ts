import type { SdkResultModelUsage } from '../../agent/types.js';

export const CREDIT_MICRO = 1_000_000;
export const YUAN_MICRO = 1_000_000;
export const DEFAULT_CREDIT_VALUE_YUAN_MICRO = 10_000; // 0.01 yuan
export const DEFAULT_TARGET_MARGIN_BPS = 6000;
export const DEFAULT_FX_RATE_TO_CNY = 7.2;
export const DEFAULT_PRICING_VERSION = '2026-06-27-v1';
export const DEFAULT_BILLING_POLICY_VERSION = '2026-06-27-default';

export type BillingMode = 'prepaid' | 'postpaid' | 'trial' | 'internal';
/**
 * 硬封顶模式。
 * - `none`：完全不挡
 * - `stop_before_run`：每次计费动作前按实际已结算用量检查额度，超额后停止后续动作
 *
 * 历史枚举值 `reserve_then_run` 通过 `normalizeTenantPolicy` 兜底为 `stop_before_run`。
 */
export type HardCapMode = 'none' | 'stop_before_run';
export type BillingMemberBudgetEnforcementMode = 'notify' | 'stop_new_runs';
export type LedgerType = 'recharge' | 'grant' | 'debit' | 'refund' | 'adjustment' | 'expire' | 'reversal' | 'reserve' | 'release';

export type BillingDecisionCode =
  | 'BILLING_ORG_BALANCE_EXHAUSTED'
  | 'BILLING_RUN_LIMIT_NOT_CONFIGURED'
  | 'BILLING_MEMBER_MONTHLY_LIMIT_EXCEEDED'
  | 'BILLING_MEMBER_PER_RUN_LIMIT_EXCEEDED'
  | 'BILLING_RUN_LIMIT_EXCEEDED';

export interface BillingRunAllowanceInput {
  tenantId: string;
  userId?: string;
  runId: string;
  now?: Date;
}

export type BillingRunAllowanceDecision =
  | { ok: true }
  | { ok: false; code: BillingDecisionCode; reason: string };

export interface BillingPricingVersion {
  version: string;
  name: string;
  status: 'draft' | 'active' | 'retired';
  effectiveFrom: string;
  effectiveTo?: string;
  creditValueYuanMicro: number;
  defaultTargetMarginBps: number;
  /** USD → CNY 汇率；由当前 active 版本提供，写入 usage_events.fx_rate_to_cny 留痕 */
  fxRateToCny: number;
  currency: 'CNY';
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface TenantBillingPolicy {
  tenantId: string;
  policyVersion: string;
  billingEnabled: boolean;
  pricingVersion: string;
  billingMode: BillingMode;
  defaultTargetMarginBps: number;
  organizationMultiplierBps: number;
  allowNegativeBalance: boolean;
  negativeLimitCreditsMicro: number;
  lowBalanceThresholdCreditsMicro: number;
  hardCapMode: HardCapMode;
  /** 组织级单个 Run 的实际累计用量上限；hardCapMode=stop_before_run 时必须配置为正数。 */
  maxRunCreditsMicro?: number;
  showBalance: boolean;
  showUsageCredits: boolean;
  showCost: boolean;
  showGrossMargin: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface BillingUsageEvent {
  id: string;
  idempotencyKey: string;
  tenantId: string;
  userId?: string;
  username: string;
  sessionId?: string;
  runId?: string;
  messageId?: string;
  channel: string;
  billable: boolean;
  modelRef?: string;
  modelValue: string;
  actualModel?: string;
  provider?: string;
  modelTier?: string;
  requestIndex: number;
  responseId?: string;
  inputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  cacheStorageTokens: number;
  cacheStorageHours: number;
  outputTokens: number;
  reasoningTokens: number;
  apiRequestCount: number;
  inputSegment: string;
  usageAccounting: string;
  pricingVersion: string;
  costCurrency: 'CNY';
  fxRateToCny: number;
  actualCostYuanMicro: number;
  rawUsageJson: unknown;
  createdAt: string;
}

export interface BillingCreditAccount {
  tenantId: string;
  balanceCreditsMicro: number;
  updatedAt: string;
}

export interface BillingLedgerEntry {
  id: string;
  idempotencyKey: string;
  tenantId: string;
  accountId: string;
  type: LedgerType;
  source: string;
  relatedUsageEventIds: string[];
  userId?: string;
  usernameSnapshot?: string;
  sessionId?: string;
  runId?: string;
  messageId?: string;
  reversesLedgerId?: string;
  creditsDeltaMicro: number;
  balanceBeforeMicro: number;
  balanceAfterMicro: number;
  creditValueYuanMicro: number;
  revenueYuanMicro: number;
  actualCostYuanMicro: number;
  grossProfitYuanMicro: number;
  grossMarginBps?: number;
  pricingVersion: string;
  billingPolicyVersion: string;
  note?: string;
  createdBy?: string;
  createdAt: string;
}

export interface BillingMemberBudgetUsage {
  userId: string;
  monthlyLimitCreditsMicro?: number;
  enforcementMode: BillingMemberBudgetEnforcementMode;
  perRunLimitCreditsMicro?: number;
  active: boolean;
  version: number;
  monthUsedCreditsMicro: number;
  remainingCreditsMicro?: number;
  canStartRun: boolean;
  lastUsedAt?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface BillingMemberBudgetOverview {
  tenantId: string;
  timezone: 'Asia/Shanghai';
  periodStart: string;
  periodEnd: string;
  monthUsedCreditsMicro: number;
  unattributedCreditsMicro: number;
  items: BillingMemberBudgetUsage[];
}

export interface BillingMemberBudgetAuditEntry {
  id: string;
  idempotencyKey: string;
  tenantId: string;
  userId: string;
  beforeLimitCreditsMicro?: number;
  afterLimitCreditsMicro?: number;
  beforeEnforcementMode?: BillingMemberBudgetEnforcementMode;
  afterEnforcementMode?: BillingMemberBudgetEnforcementMode;
  beforePerRunLimitCreditsMicro?: number;
  afterPerRunLimitCreditsMicro?: number;
  beforeActive: boolean;
  afterActive: boolean;
  periodStart: string;
  note: string;
  actorUserId: string;
  actorUsername: string;
  createdAt: string;
}

export interface BillingSummary {
  tenantId: string;
  balanceCredits: number;
  lowBalance: boolean;
  billingEnabled: boolean;
  billingMode: BillingMode;
  pricingVersion: string;
  policyVersion: string;
  creditValueYuan: number;
  currentMonthCreditsUsed: number;
  currentMonthRevenueYuan: number;
  currentMonthActualCostYuan?: number;
  currentMonthGrossMarginBps?: number;
}

export interface BillingProjectionResult {
  usageEventsInserted: number;
  debitEntriesInserted: number;
  lastProjectedSequence: number;
}

export interface BillingAuditSummary {
  tenantId?: string;
  days: number;
  actualCostYuanMicro: number;
  revenueYuanMicro: number;
  creditsChargedMicro: number;
  grossProfitYuanMicro: number;
  grossMarginBps: number | null;
  unpricedUsageEvents: number;
  lowBalanceTenants: Array<{ tenantId: string; balanceCreditsMicro: number; thresholdCreditsMicro: number }>;
  alerts: string[];
  /** 仅平台跨租户聚合视图返回；按 Beijing TZ 按日分桶 */
  daily?: BillingAuditDailyPoint[];
}

export interface BillingAuditDailyPoint {
  /** YYYY-MM-DD，Beijing TZ */
  date: string;
  actualCostYuanMicro: number;
  revenueYuanMicro: number;
  creditsChargedMicro: number;
  grossProfitYuanMicro: number;
}

export interface ProjectedRuntimeUsageInput {
  idempotencyKey: string;
  tenantId: string;
  userId?: string;
  username: string;
  sessionId?: string;
  runId?: string;
  channel: string;
  modelValue: string;
  actualModel?: string;
  requestIndex: number;
  usage: SdkResultModelUsage;
  rawUsageJson: unknown;
  occurredAt: string;
  /**
   * 强制豁免（2026-07-14 memory_poll 批次）：false = 该 usage event 不参与
   * ledger debit 结算（settleRunDebit 只取 billable=true），用量照记。
   * 缺省时按租户 policy（billingEnabled && billingMode!=='internal'）判定。
   */
  billable?: boolean;
  /**
   * 固定成本旁路（2026-07-15 metered_tool_usage 批次）：非 token 计价项
   * （如生图按张）由事件直接携带真实成本（micro-yuan），绕过 computeCostMicro
   * 的 token 单价表（token 全 0 会算出 0 成本 + 未知模型告警）。
   */
  fixedCostYuanMicro?: number;
}

/**
 * 按次固定扣费入参（2026-07-15 GenerateImage 批次）。
 * 与 settleRunDebit 的 cost-plus 公式不同：credits 是产品定价的固定面值，
 * revenue = credits × credit 面值；actualCost 由调用方携带，毛利审计
 * （<45% 告警）对固定扣费同样生效。
 */
export interface FixedDebitInput {
  tenantId: string;
  userId?: string;
  username?: string;
  /** 建议 `debit:tool:v1:${eventId}`——锚定事件 id，投影重跑/事件重放不重复扣。 */
  idempotencyKey: string;
  /** ledger source，如 'tool:image_gen'。与 settleRunDebit 的 'usage_event' 隔离，互不去重。 */
  source: string;
  /** 应扣积分（micro-credits，正数面值；内部会取负写入 ledger）。 */
  creditsMicro: number;
  /** 本次真实成本（micro-yuan），供毛利审计。 */
  actualCostYuanMicro: number;
  relatedUsageEventIds?: string[];
  sessionId?: string;
  runId?: string;
  note?: string;
}
