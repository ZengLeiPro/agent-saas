import { isRecord, readGrokJson } from './grokProtocol.js';
export interface GrokRejectedResponse {
  kind: 'quota' | 'auth' | 'other';
  code: string;
  message: string;
  status: number;
  retryAfter?: string;
}
/** Provider-specific evidence: OpenClaw xAI billing/rate-limit classifier, not Codex text matching. */
export async function classifyGrokResponse(response: Response): Promise<GrokRejectedResponse> {
  let message = '';
  try {
    const raw = await readGrokJson(response);
    const error = isRecord(raw) && isRecord(raw.error) ? raw.error : raw;
    if (isRecord(error) && typeof error.message === 'string') message = error.message;
  } catch {
    /* HTML/challenges/malformed responses never become quota or permanent authorization. */
  }
  const retryAfter = safeRetryAfter(response.headers.get('retry-after'));
  if (response.status === 401)
    return {
      kind: 'auth',
      code: 'grok_access_token_rejected',
      message: 'Grok 订阅凭据被拒绝，请重新授权。',
      status: 401,
    };
  const ordinaryRateLimit = /\b(?:rate limit exceeded|too many requests)\b/i.test(message);
  const exhausted =
    /\b(?:used all available credits|run out of credits|monthly spending limit|purchase more credits|raise your spending limit)\b/i.test(
      message,
    );
  if ([400, 402, 403, 429].includes(response.status) && exhausted && !ordinaryRateLimit) {
    return {
      kind: 'quota',
      code: 'grok_subscription_quota_exhausted',
      message: 'Grok 订阅额度耗尽，账号已进入额度冷却。',
      status: 429,
      retryAfter,
    };
  }
  const code =
    response.status === 429
      ? 'grok_rate_limited'
      : response.status === 403
        ? 'grok_access_forbidden'
        : response.status >= 500
          ? 'grok_upstream_unavailable'
          : 'grok_request_rejected';
  return {
    kind: 'other',
    code,
    status: response.status,
    retryAfter,
    message:
      response.status === 429
        ? 'Grok 请求受到上游限流；未将普通限流当作套餐耗尽，也未轮换账号规避限制。'
        : 'Grok 订阅请求未被接受；请检查模型资格、服务状态或授权链路。',
  };
}
export function grokErrorResponse(failure: GrokRejectedResponse, retryAt?: string): Response {
  const retryAfter = retryAt
    ? String(Math.max(0, Math.ceil((Date.parse(retryAt) - Date.now()) / 1000)))
    : failure.retryAfter;
  return new Response(
    JSON.stringify({
      error: { code: failure.code, message: failure.message, ...(retryAt ? { retryAt } : {}) },
    }),
    {
      status: failure.status,
      headers: {
        'content-type': 'application/json',
        ...(retryAfter ? { 'retry-after': retryAfter } : {}),
      },
    },
  );
}
function safeRetryAfter(value: string | null): string | undefined {
  if (!value || value.length > 64) return undefined;
  if (/^\d{1,6}$/.test(value)) return value;
  return /^[A-Za-z]{3}, [\d A-Za-z:]+ GMT$/.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}
