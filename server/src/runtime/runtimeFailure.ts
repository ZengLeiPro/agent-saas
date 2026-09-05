import { mapCanonicalError, type CanonicalError } from '@agent/shared';
import type { RuntimeFailureKind, RuntimeRecoveryAction } from '../types/index.js';
import type { ModelRetryBlockedReason } from './modelRetryTypes.js';

export interface RuntimeFailureProtocol {
  failureKind: RuntimeFailureKind;
  recoveryAction: RuntimeRecoveryAction;
  /** 仅 quota_exhausted：上游结构化字段给出的配额窗口绝对重置时刻（ISO） */
  quotaResetAt?: string;
}

export const POLICY_REJECTION_CUSTOMER_MESSAGE = '当前模型受策略限制，请切换其他模型继续。';
export const QUOTA_EXHAUSTED_CUSTOMER_MESSAGE = '当前模型额度已用尽，请切换其他模型。';

export function customerSafeRuntimeError(
  errorMessage: string | undefined,
  failureKind: RuntimeFailureKind | undefined,
): string | undefined {
  if (failureKind === 'policy_rejection') return POLICY_REJECTION_CUSTOMER_MESSAGE;
  if (failureKind === 'quota_exhausted') return QUOTA_EXHAUSTED_CUSTOMER_MESSAGE;
  return errorMessage;
}

const POLICY_REJECTION_ERROR_CODES = new Set(['cyber_policy']);

/**
 * 配额耗尽的上游**结构化错误码**白名单。
 *
 * 只认明确错误码，绝不从自由文本正则猜（2026-08-23 红线）——上游文案随时会变，
 * 猜错的代价是把普通限流当成配额耗尽、直接劝用户换模型。
 * 来源：
 * - 火山 Ark Responses 429：QuotaExceeded / AccountQuotaExceeded（2026-08-03 生产样本）
 * - OpenAI / Codex Responses 429：usage_limit_reached / insufficient_quota（2026-08-24 生产样本）
 * 归一化口径与 shared canonicalError 的 normalizedCode 一致（小写 + 分隔符转 _）。
 */
const QUOTA_EXHAUSTED_ERROR_CODES = new Set([
  'quotaexceeded', 'quota_exceeded',
  'accountquotaexceeded', 'account_quota_exceeded',
  'insufficient_quota', 'usage_limit_reached', 'usage_limit_exceeded',
  'billing_hard_limit_reached', 'quota_exhausted',
]);

/** 与 shared canonicalError.normalizedCode 同口径 */
function normalizeErrorCode(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length > 120) return undefined;
  const normalized = value.trim().toLowerCase().replace(/[.\s-]+/g, '_');
  return /^[a-z0-9_]+$/.test(normalized) ? normalized : undefined;
}

/** 上游 429/配额错误码 → canonical reasonCode（只认结构化码，其余留给 rate_limited 兜底） */
export function quotaExhaustedReasonCode(errorCode: string | undefined): 'quota_exhausted' | undefined {
  const code = normalizeErrorCode(errorCode);
  return code && QUOTA_EXHAUSTED_ERROR_CODES.has(code) ? 'quota_exhausted' : undefined;
}

/**
 * 从上游错误体里取配额窗口的**绝对重置时刻**。
 *
 * 只读结构化字段：
 * - Codex/OpenAI：`error.resets_at`（epoch 秒）/ `error.resets_in_seconds`（相对秒）
 * - 通用：`Retry-After` 秒数（调用方换算好后传 retryAfterSeconds）
 * 文本里的时间（如「5-hour usage quota ... 05:10:35」）一律不解析。
 */
export function parseQuotaResetAt(input: {
  resetsAt?: unknown;
  resetsInSeconds?: unknown;
  retryAfterSeconds?: unknown;
  nowMs?: number;
}): string | undefined {
  const now = input.nowMs ?? Date.now();
  const MAX_AHEAD_MS = 24 * 60 * 60 * 1000;
  const fromEpoch = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    // 秒 / 毫秒两种单位都见过；按量级判定，避免把毫秒戳当秒。
    return value > 1e12 ? value : value * 1000;
  };
  const fromRelativeSeconds = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    return now + value * 1000;
  };
  const at = fromEpoch(input.resetsAt)
    ?? fromRelativeSeconds(input.resetsInSeconds)
    ?? fromRelativeSeconds(input.retryAfterSeconds);
  if (at === undefined || at <= now || at > now + MAX_AHEAD_MS) return undefined;
  return new Date(at).toISOString();
}

/** M40-05 adapter: runtimeFailure remains the runtime authority; UI consumes canonical semantics. */
export function mapRuntimeFailureToCanonical(input: {
  failureKind?: RuntimeFailureKind;
  errorCode?: string;
  correlationId?: string;
  retryAfterMs?: number;
  quotaResetAt?: string;
  legacyMessage?: string;
}): CanonicalError {
  const code = input.failureKind === 'policy_rejection'
    ? 'capability_unavailable'
    : input.failureKind === 'quota_exhausted'
      ? 'quota_exhausted'
      : input.errorCode;
  return mapCanonicalError({
    source: 'runtime',
    code,
    correlationId: input.correlationId,
    retryAfterMs: input.retryAfterMs,
    resetAt: input.quotaResetAt,
    legacyMessage: input.legacyMessage,
  });
}

export function classifyModelFailure(
  errorCode: string | undefined,
  retryBlockedReason: ModelRetryBlockedReason | undefined,
  quotaResetAt?: string,
): RuntimeFailureProtocol | undefined {
  if (retryBlockedReason !== 'permanent_error' || !errorCode) return undefined;
  if (POLICY_REJECTION_ERROR_CODES.has(errorCode.toLowerCase())) {
    return { failureKind: 'policy_rejection', recoveryAction: 'switch_model' };
  }
  // 配额耗尽：窗口重置前重试必然再被拒，客户面唯一有效动作同样是换模型。
  if (quotaExhaustedReasonCode(errorCode)) {
    return {
      failureKind: 'quota_exhausted',
      recoveryAction: 'switch_model',
      ...(quotaResetAt ? { quotaResetAt } : {}),
    };
  }
  return undefined;
}

export { SessionAutomationBackgroundResource } from './background/sessionAutomationBackgroundResource.js';
