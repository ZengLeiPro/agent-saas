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
 * - `stop_before_run`：余额（含 reserve）不足且超出 negativeLimit 时拒绝新任务
 *
 * 历史枚举值 `reserve_then_run` 自 2026-06-28 起从产品 UI 摘除：当时后端无 reserve/release
 * 实现，与 `stop_before_run` 行为完全等价，UI 暴露 = 假承诺。LedgerType `reserve|release`
 * 与 `reservedCreditsMicro` 字段保留，留给未来 P2 真正实装预留逻辑。
 * 历史数据通过 `normalizeTenantPolicy` 兜底为 `stop_before_run`。
 */
export type HardCapMode = 'none' | 'stop_before_run';
export type LedgerType = 'recharge' | 'grant' | 'debit' | 'refund' | 'adjustment' | 'expire' | 'reversal' | 'reserve' | 'release';

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
  reservedCreditsMicro: number;
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
  sessionId?: string;
  runId?: string;
  messageId?: string;
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

export interface BillingSummary {
  tenantId: string;
  balanceCredits: number;
  reservedCredits: number;
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
}
