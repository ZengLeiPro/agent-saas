/**
 * Provider HTTP 错误体解析与发流前失败归类。
 *
 * 从 responsesApiAdapter 抽出，供 Responses / Chat Completions 两个适配器共用：
 * 上游错误体 → 结构化字段（code / message / quotaResetAt）→ 是否可重试。
 * 客户面归类只认结构化错误码，自由文本正则一律只影响重试决策（2026-08-23 红线）。
 */
import { compactDiagnosticMessage, compactDiagnosticToken } from './responsesAttemptDiagnostics.js';
import { parseQuotaResetAt, quotaExhaustedReasonCode } from './runtimeFailure.js';

export function providerErrorDiagnosticMessage(status: number, code: string | undefined): string {
  const candidate = compactDiagnosticToken(code, 120);
  const safeCode = candidate && /^[A-Za-z0-9_.:-]+$/.test(candidate) ? candidate : undefined;
  if (safeCode?.toLowerCase() === 'invalid_prompt') {
    return `Responses API HTTP ${status}: Request blocked by provider`;
  }
  return `Responses API HTTP ${status}${safeCode ? ` (${safeCode})` : ''}`;
}

export function extractProviderError(text: string): {
  code?: string;
  message?: string;
  /** 结构化配额重置时刻（ISO）；只从 error.resets_at / resets_in_seconds 解析，不碰文本 */
  quotaResetAt?: string;
} {
  try {
    const parsed = JSON.parse(text) as Record<string, any>;
    const error = parsed.error ?? parsed;
    // Codex/OpenAI 把配额码放在 error.type（usage_limit_reached），火山放在 error.code。
    const code =
      typeof error?.code === 'string' && error.code.trim()
        ? error.code
        : typeof error?.type === 'string'
          ? error.type
          : undefined;
    const quotaResetAt = parseQuotaResetAt({
      resetsAt: error?.resets_at,
      resetsInSeconds: error?.resets_in_seconds,
    });
    return {
      ...(code ? { code: compactDiagnosticMessage(code) } : {}),
      ...(typeof error?.message === 'string'
        ? { message: compactDiagnosticMessage(error.message) }
        : {}),
      ...(quotaResetAt ? { quotaResetAt } : {}),
    };
  } catch {
    const message = compactDiagnosticMessage(text);
    return message ? { message } : {};
  }
}

export function isInvalidEncryptedContent(
  status: number,
  code: string | undefined,
  message: string,
): boolean {
  if (status !== 400) return false;
  return /invalid[_\s-]?encrypted[_\s-]?content/i.test(`${code ?? ''} ${message}`);
}

/**
 * 遗留自由文本兜底：上游没给结构化码时的最后一层判据。
 * 只允许影响「要不要重试」，绝不能用于客户面归类——文案随时会变，
 * 猜错的代价是把普通限流当成配额耗尽、直接劝用户换模型。
 */
const LEGACY_QUOTA_EXHAUSTED_TEXT =
  /quota[_\s-]?exceeded|insufficient[_\s-]?quota|exhausted its free trial|额度(?:已)?(?:用尽|耗尽)/i;

export function matchesLegacyQuotaExhaustedText(value: string): boolean {
  return LEGACY_QUOTA_EXHAUSTED_TEXT.test(value);
}

// 429 里额度/配额耗尽类：需要人工充值或扩配额才能恢复，重试只会连续撞同一堵墙。
// 限流（RPM/TPM）、服务过载、模型加载中都不属于这一类，退避后通常可恢复。
//
// 分两层：结构化错误码白名单（唯一用于客户面归类的依据，含 2026-08-24 漏掉的
// usage_limit_reached）+ 遗留文本兜底（只影响是否重试，不影响客户面分类）。
export function isQuotaExhausted(code: string | undefined, message: string): boolean {
  if (quotaExhaustedReasonCode(code)) return true;
  return matchesLegacyQuotaExhaustedText(`${code ?? ''} ${message}`);
}

export function isRetryablePreStreamHttpError(
  status: number,
  code: string | undefined,
  message: string,
): boolean {
  if (status === 502 || status === 503 || status === 504) return true;
  // 429 发流前被拒 = 上游未接单、不计费，退避重试只花时延不花钱；
  // 覆盖 ServerOverloaded / ModelLoadingError / RPM·TPM 限流等可自愈形态。
  if (status === 429) return !isQuotaExhausted(code, message);
  if (status !== 500) return false;
  return (
    /\b(?:EOF|ECONNRESET|EPIPE|ETIMEDOUT)\b|socket hang up|connection (?:reset|closed)|unexpected end of file/i.test(
      message,
    ) || /stream error:\s*stream ID \d+;\s*PROTOCOL_ERROR;\s*received from peer/i.test(message)
  );
}
