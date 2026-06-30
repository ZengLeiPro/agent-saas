export const DEFAULT_RUNTIME_FAILURE_MESSAGE = "异常中断，请继续对话";
export const MODEL_REQUEST_FAILURE_MESSAGE = "模型请求错误，请稍后重试";

const MODEL_HTTP_5XX_RE = /\b(?:Responses API|Chat Completions) HTTP 5\d\d\b/i;

export function isModelRequestFailure(error?: string | null): boolean {
  if (!error) return false;
  return MODEL_HTTP_5XX_RE.test(error);
}

export function formatRuntimeFailureMessage(error?: string | null): string {
  if (isModelRequestFailure(error)) return MODEL_REQUEST_FAILURE_MESSAGE;
  return DEFAULT_RUNTIME_FAILURE_MESSAGE;
}
