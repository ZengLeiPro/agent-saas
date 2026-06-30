import type { WebEgressPolicy } from './ssrf.js';

export type WebSearchProviderId = 'brave' | 'volcengine';

export interface WebSearchInput {
  query: string;
  count: number;
  freshness?: 'day' | 'week' | 'month' | 'year';
  allowedDomains?: string[];
  blockedDomains?: string[];
  signal?: AbortSignal;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  source?: string;
}

export interface WebSearchProviderConfig {
  provider?: WebSearchProviderId;
  endpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxResults?: number;
  egress?: WebEgressPolicy;
}

export interface WebSearchOutput {
  provider: WebSearchProviderId;
  query: string;
  results: WebSearchResultItem[];
  fetchedAt: string;
  truncated: boolean;
}

const DEFAULT_BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_VOLCENGINE_ENDPOINT = 'https://open.feedcoopapi.com/search_api/web_search';

export async function runWebSearch(
  config: WebSearchProviderConfig,
  input: WebSearchInput,
  fetchImpl: typeof fetch = fetch,
): Promise<WebSearchOutput> {
  const provider = config.provider ?? 'volcengine';
  if (provider === 'brave') {
    return runBraveSearch(config, input, fetchImpl);
  }
  if (provider === 'volcengine') {
    return runVolcengineSearch(config, input, fetchImpl);
  }
  throw new Error(`Unsupported web search provider: ${provider}`);
}

async function runBraveSearch(
  config: WebSearchProviderConfig,
  input: WebSearchInput,
  fetchImpl: typeof fetch,
): Promise<WebSearchOutput> {
  if (!config.apiKey) {
    throw new Error('WebSearch provider "brave" is missing apiKey/apiKeyRef.');
  }
  const count = clamp(input.count, 1, config.maxResults ?? 10);
  const url = new URL(config.endpoint || DEFAULT_BRAVE_ENDPOINT);
  url.searchParams.set('q', withDomainFilters(input.query, input.allowedDomains, input.blockedDomains));
  url.searchParams.set('count', String(count));
  if (input.freshness) url.searchParams.set('freshness', input.freshness);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 8_000);
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal,
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': config.apiKey,
      },
    });
    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {};
      }
    }
    if (!response.ok) {
      throw new Error(`WebSearch provider "brave" failed with HTTP ${response.status}: ${extractError(payload, text)}`);
    }
    const allResults = normalizeBraveResults(payload);
    return {
      provider: 'brave',
      query: input.query,
      results: allResults.slice(0, count),
      fetchedAt: new Date().toISOString(),
      truncated: allResults.length > count,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runVolcengineSearch(
  config: WebSearchProviderConfig,
  input: WebSearchInput,
  fetchImpl: typeof fetch,
): Promise<WebSearchOutput> {
  if (!config.apiKey) {
    throw new Error('WebSearch provider "volcengine" is missing apiKey/apiKeyRef.');
  }
  const count = clamp(input.count, 1, config.maxResults ?? 10);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 8_000);
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchImpl(config.endpoint || DEFAULT_VOLCENGINE_ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildVolcengineRequest(input, count)),
    });
    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {};
      }
    }
    if (!response.ok) {
      throw new Error(`WebSearch provider "volcengine" failed with HTTP ${response.status}: ${extractError(payload, text)}`);
    }
    const apiError = extractVolcengineError(payload);
    if (apiError) {
      throw new Error(`WebSearch provider "volcengine" failed: ${apiError}`);
    }
    const allResults = normalizeVolcengineResults(payload);
    return {
      provider: 'volcengine',
      query: input.query,
      results: allResults.slice(0, count),
      fetchedAt: new Date().toISOString(),
      truncated: allResults.length > count || getVolcengineResultCount(payload) > count,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildVolcengineRequest(input: WebSearchInput, count: number): Record<string, unknown> {
  const filter: Record<string, unknown> = { NeedUrl: true };
  const allowedSites = formatVolcengineHosts(input.allowedDomains, 20);
  const blockedHosts = formatVolcengineHosts(input.blockedDomains, 5);
  if (allowedSites) filter.Sites = allowedSites;
  if (blockedHosts) filter.BlockHosts = blockedHosts;

  return {
    Query: input.query,
    SearchType: 'web',
    Count: count,
    Filter: filter,
    ContentFormats: 'markdown',
    ...(input.freshness ? { TimeRange: mapVolcengineTimeRange(input.freshness) } : {}),
  };
}

function normalizeVolcengineResults(payload: unknown): WebSearchResultItem[] {
  const result = getObject(getObject(payload).Result);
  const results = Array.isArray(result.WebResults) ? result.WebResults : [];
  return results.flatMap((raw) => {
    const item = getObject(raw);
    const title = firstString(item.Title, item.title);
    const url = firstString(item.Url, item.URL, item.url);
    if (!title || !url) return [];
    const normalized: WebSearchResultItem = { title, url };
    const snippet = firstString(item.Snippet, item.Summary, item.Description, item.Content);
    if (snippet) normalized.snippet = snippet;
    const publishedAt = firstString(item.PublishTime, item.PublishedAt, item.publishedAt);
    if (publishedAt) normalized.publishedAt = publishedAt;
    const source = firstString(item.SiteName, item.Source, item.source);
    if (source) normalized.source = source;
    return [normalized];
  });
}

function normalizeBraveResults(payload: unknown): WebSearchResultItem[] {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const web = data.web && typeof data.web === 'object' ? data.web as Record<string, unknown> : {};
  const results = Array.isArray(web.results) ? web.results : [];
  return results.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const title = typeof item.title === 'string' ? item.title : undefined;
    const url = typeof item.url === 'string' ? item.url : undefined;
    if (!title || !url) return [];
    const result: WebSearchResultItem = { title, url };
    if (typeof item.description === 'string') result.snippet = item.description;
    if (typeof item.age === 'string') result.publishedAt = item.age;
    if (typeof item.profile === 'object' && item.profile) {
      const profile = item.profile as Record<string, unknown>;
      if (typeof profile.name === 'string') result.source = profile.name;
    }
    return [result];
  });
}

function formatVolcengineHosts(hosts: string[] | undefined, limit: number): string | undefined {
  const values = (hosts ?? [])
    .map((host) => host.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''))
    .filter(Boolean)
    .slice(0, limit);
  return values.length > 0 ? values.join('|') : undefined;
}

function mapVolcengineTimeRange(freshness: NonNullable<WebSearchInput['freshness']>): string {
  switch (freshness) {
    case 'day': return 'OneDay';
    case 'week': return 'OneWeek';
    case 'month': return 'OneMonth';
    case 'year': return 'OneYear';
  }
}

function withDomainFilters(query: string, allowedDomains?: string[], blockedDomains?: string[]): string {
  const parts = [query];
  for (const domain of allowedDomains ?? []) {
    if (domain.trim()) parts.push(`site:${domain.trim()}`);
  }
  for (const domain of blockedDomains ?? []) {
    if (domain.trim()) parts.push(`-site:${domain.trim()}`);
  }
  return parts.join(' ');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function getObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function getVolcengineResultCount(payload: unknown): number {
  const result = getObject(getObject(payload).Result);
  return typeof result.ResultCount === 'number' ? result.ResultCount : 0;
}

function extractVolcengineError(payload: unknown): string | undefined {
  const metadata = getObject(getObject(payload).ResponseMetadata);
  const error = getObject(metadata.Error);
  const code = firstString(error.Code, error.code);
  const message = firstString(error.Message, error.message);
  if (code || message) return [code, message].filter(Boolean).join(': ');
  return undefined;
}

function extractError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error;
    if (record.error && typeof record.error === 'object') {
      const error = record.error as Record<string, unknown>;
      if (typeof error.message === 'string') return error.message;
    }
    if (typeof record.message === 'string') return record.message;
  }
  return fallback.slice(0, 500);
}
