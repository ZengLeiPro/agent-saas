export const DEFAULT_RUNTIME_FAILURE_MESSAGE = "异常中断，请继续对话";
export const MODEL_REQUEST_FAILURE_MESSAGE = "模型请求错误，请稍后重试";
export const INSUFFICIENT_CREDITS_FAILURE_MESSAGE = "当前组织积分余额不足，本次任务尚未开始。请补充积分或联系组织管理员调整额度后再试。";

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

export function formatRuntimeFailureMessage(error?: string | null): string {
  if (isInsufficientCreditsFailure(error)) return INSUFFICIENT_CREDITS_FAILURE_MESSAGE;
  if (isModelRequestFailure(error)) return MODEL_REQUEST_FAILURE_MESSAGE;
  return DEFAULT_RUNTIME_FAILURE_MESSAGE;
}
