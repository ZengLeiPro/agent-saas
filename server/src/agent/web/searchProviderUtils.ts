import type { WebSearchResultItem } from './searchProviderTypes.js';

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function getObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

export function normalizeHostname(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** 供不支持服务端域名过滤的 provider（腾讯/智谱/Tavily）在本地兜底过滤。 */
export function filterByDomains(
  results: WebSearchResultItem[],
  allowedDomains?: string[],
  blockedDomains?: string[],
): WebSearchResultItem[] {
  const allowed = (allowedDomains ?? []).map(normalizeHostname).filter((host): host is string => !!host);
  const blocked = (blockedDomains ?? []).map(normalizeHostname).filter((host): host is string => !!host);
  if (allowed.length === 0 && blocked.length === 0) return results;
  return results.filter((result) => {
    // 无源链接的结果无法判定域名；调用方一旦显式限定域名，就不能把它算作命中。
    if (!result.url) return false;
    let hostname: string;
    try {
      hostname = new URL(result.url).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (allowed.length > 0 && !allowed.some((domain) => hostMatches(hostname, domain))) return false;
    return !blocked.some((domain) => hostMatches(hostname, domain));
  });
}

export function extractError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error;
    if (record.error && typeof record.error === 'object') {
      const error = record.error as Record<string, unknown>;
      if (typeof error.message === 'string') return error.message;
    }
    if (typeof record.message === 'string') return record.message;
    if (typeof record.detail === 'string') return record.detail;
  }
  return fallback.slice(0, 500);
}
