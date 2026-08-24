export const DEFAULT_RUNTIME_FAILURE_MESSAGE = "回复已中断";
export const MODEL_REQUEST_FAILURE_MESSAGE = DEFAULT_RUNTIME_FAILURE_MESSAGE;
export const INSUFFICIENT_CREDITS_FAILURE_MESSAGE = "当前组织积分余额不足，本次任务尚未开始。请补充积分或联系组织管理员调整额度后再试。";
export const POLICY_REJECTION_FAILURE_MESSAGE = "当前模型受策略限制，请切换其他模型继续。";

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

export function formatRuntimeFailureMessage(
  error?: string | null,
  failureKind?: 'policy_rejection',
): string {
  if (failureKind === 'policy_rejection') return POLICY_REJECTION_FAILURE_MESSAGE;
  if (isInsufficientCreditsFailure(error)) return INSUFFICIENT_CREDITS_FAILURE_MESSAGE;
  if (isModelRequestFailure(error)) return MODEL_REQUEST_FAILURE_MESSAGE;
  return DEFAULT_RUNTIME_FAILURE_MESSAGE;
}
