import type { RuntimeFailureKind } from "../types/runtimeFailure";
import { formatQuotaResetClock } from "./clientFailureCopy";

export const DEFAULT_RUNTIME_FAILURE_MESSAGE = "回复已中断";
export const MODEL_REQUEST_FAILURE_MESSAGE = DEFAULT_RUNTIME_FAILURE_MESSAGE;
export const INSUFFICIENT_CREDITS_FAILURE_MESSAGE = "当前组织积分余额不足，本次任务尚未开始。请补充积分或联系组织管理员调整额度后再试。";
export const POLICY_REJECTION_FAILURE_MESSAGE = "当前模型受策略限制，请切换其他模型继续。";
export const QUOTA_EXHAUSTED_FAILURE_MESSAGE = "当前模型额度已用尽，请切换其他模型。";

const MODEL_HTTP_5XX_RE = /\b(?:Responses API|Chat Completions) HTTP 5\d\d\b/i;
const INSUFFICIENT_CREDITS_RE = /组织积分余额不足|积分余额不足.*硬封顶/i;

export function isModelRequestFailure(error?: string | null): boolean {
  if (!error) return false;
  return MODEL_HTTP_5XX_RE.test(error);
}

export function isInsufficientCreditsFailure(error?: string | null): boolean {
  if (!error) return false;
  return INSUFFICIENT_CREDITS_RE.test(error);
}

export function isSameRunMessage(
  message: { runId?: string; content?: string } | null | undefined,
  runId: string | undefined,
  content: string,
): boolean {
  return Boolean(message && message.runId === runId && message.content === content);
}

/**
 * 终态文案的唯一口径。配额型失败绝不能落到默认的「请发送『继续』」——
 * 窗口重置前继续必然再失败（2026-08-03 生产事故）。
 *
 * `quotaResetAt` 是服务端从上游结构化字段解析出的绝对重置时刻；
 * 拿不到就只给结论文案，不猜时间。
 */
export function formatRuntimeFailureMessage(
  error?: string | null,
  failureKind?: RuntimeFailureKind,
  quotaResetAt?: string,
): string {
  if (failureKind === 'quota_exhausted') {
    const at = formatQuotaResetClock(quotaResetAt);
    return at ? `${QUOTA_EXHAUSTED_FAILURE_MESSAGE}额度将在 ${at} 重置。` : QUOTA_EXHAUSTED_FAILURE_MESSAGE;
  }
  if (failureKind === 'policy_rejection') return POLICY_REJECTION_FAILURE_MESSAGE;
  if (isInsufficientCreditsFailure(error)) return INSUFFICIENT_CREDITS_FAILURE_MESSAGE;
  if (isModelRequestFailure(error)) return MODEL_REQUEST_FAILURE_MESSAGE;
  return DEFAULT_RUNTIME_FAILURE_MESSAGE;
}
