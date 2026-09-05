import type { ProviderQuotaWindow } from '@agent/shared';

import { epochSecondsToIso, finiteNumber, quotaWindowLabel } from './quotaWindowLabel.js';

/**
 * Codex 订阅账号额度：ChatGPT 后端 `wham/usage`，与 Codex CLI `/status` 同源。
 * 返回主窗口（Pro 为每周）、可选次窗口、按模型的附加限额、credits 与 plan_type。
 * 只读接口，不消耗额度；access token 沿用订阅 transport 的 SecretVault bundle。
 */
export const CODEX_USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';

const REQUEST_TIMEOUT_MS = 15_000;

export interface CodexUsageToken {
  accessToken: string;
  accountId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function fetchCodexUsage(
  fetchImpl: typeof fetch,
  token: CodexUsageToken,
): Promise<unknown> {
  const response = await fetchImpl(CODEX_USAGE_ENDPOINT, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      'ChatGPT-Account-Id': token.accountId,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Codex usage HTTP ${response.status}${text ? `：${text.slice(0, 160)}` : ''}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Codex usage 返回非 JSON：${text.slice(0, 120)}`);
  }
}

export interface NormalizedCodexUsage {
  email?: string;
  planType?: string;
  windows: ProviderQuotaWindow[];
  limitReached: boolean;
  extra: Record<string, unknown>;
}

function windowFrom(
  raw: unknown,
  id: string,
  labelPrefix: string | undefined,
): ProviderQuotaWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const usedPercent = finiteNumber(raw.used_percent);
  if (usedPercent === undefined) return undefined;
  const windowSeconds = finiteNumber(raw.limit_window_seconds);
  const label = quotaWindowLabel(windowSeconds);
  return {
    id,
    label: labelPrefix ? `${labelPrefix} · ${label}` : label,
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    usedPercent,
    unit: '%',
    ...(epochSecondsToIso(raw.reset_at) ? { resetAt: epochSecondsToIso(raw.reset_at) } : {}),
    limitReached: usedPercent >= 100,
  };
}

export function normalizeCodexUsage(raw: unknown): NormalizedCodexUsage {
  const record = isRecord(raw) ? raw : {};
  const rateLimit = isRecord(record.rate_limit) ? record.rate_limit : {};
  const windows: ProviderQuotaWindow[] = [];
  const primary = windowFrom(rateLimit.primary_window, 'primary', undefined);
  const secondary = windowFrom(rateLimit.secondary_window, 'secondary', undefined);
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  if (rateLimit.limit_reached === true) {
    for (const window of windows) window.limitReached = true;
  }
  const additional = Array.isArray(record.additional_rate_limits)
    ? record.additional_rate_limits
    : [];
  for (const entry of additional) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.limit_name === 'string' ? entry.limit_name : undefined;
    const feature =
      typeof entry.metered_feature === 'string' ? entry.metered_feature : (name ?? 'additional');
    const limit = isRecord(entry.rate_limit) ? entry.rate_limit : {};
    const extraPrimary = windowFrom(limit.primary_window, `${feature}:primary`, name);
    const extraSecondary = windowFrom(limit.secondary_window, `${feature}:secondary`, name);
    for (const window of [extraPrimary, extraSecondary]) {
      if (!window) continue;
      if (limit.limit_reached === true) window.limitReached = true;
      windows.push(window);
    }
  }
  const credits = isRecord(record.credits) ? record.credits : undefined;
  return {
    ...(typeof record.email === 'string' ? { email: record.email } : {}),
    ...(typeof record.plan_type === 'string' ? { planType: record.plan_type } : {}),
    windows,
    limitReached: rateLimit.limit_reached === true,
    extra: {
      ...(credits
        ? {
            credits: {
              balance:
                typeof credits.balance === 'string'
                  ? credits.balance
                  : finiteNumber(credits.balance),
              hasCredits: credits.has_credits === true,
              unlimited: credits.unlimited === true,
            },
          }
        : {}),
      ...(typeof record.rate_limit_reached_type === 'string'
        ? { rateLimitReachedType: record.rate_limit_reached_type }
        : {}),
    },
  };
}
