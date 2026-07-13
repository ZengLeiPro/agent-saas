import type { WebEgressPolicy } from './ssrf.js';

export type WebSearchProviderId = 'brave' | 'volcengine' | 'tencent_wsa';

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
const DEFAULT_TENCENT_WSA_ENDPOINT = 'https://api.wsa.cloud.tencent.com/SearchPro';
const TENCENT_WSA_MAX_ATTEMPTS = 3;
const TENCENT_WSA_REQUEST_INTERVAL_MS = Math.ceil(1_000 / 18);

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
  if (provider === 'tencent_wsa') {
    return runTencentWsaSearch(config, input, fetchImpl);
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

async function runTencentWsaSearch(
  config: WebSearchProviderConfig,
  input: WebSearchInput,
  fetchImpl: typeof fetch,
): Promise<WebSearchOutput> {
  if (!config.apiKey) {
    throw new Error('WebSearch provider "tencent_wsa" is missing apiKey/apiKeyRef.');
  }
  const count = clamp(input.count, 1, config.maxResults ?? 10);
  let lastError: unknown;

  for (let attempt = 1; attempt <= TENCENT_WSA_MAX_ATTEMPTS; attempt += 1) {
    await tencentWsaPacer.wait(input.signal);
    try {
      const payload = await requestTencentWsa(config, input, fetchImpl);
      const apiError = extractTencentWsaError(payload);
      if (apiError) {
        throw new TencentWsaRequestError(apiError.message, { code: apiError.code });
      }
      const allResults = filterTencentWsaResults(
        normalizeTencentWsaResults(payload),
        input.allowedDomains,
        input.blockedDomains,
      );
      return {
        provider: 'tencent_wsa',
        query: input.query,
        results: allResults.slice(0, count),
        fetchedAt: new Date().toISOString(),
        truncated: allResults.length > count,
      };
    } catch (error) {
      if (input.signal?.aborted || !isRetryableTencentWsaError(error) || attempt === TENCENT_WSA_MAX_ATTEMPTS) {
        throw error;
      }
      lastError = error;
      const retryAfterMs = error instanceof TencentWsaRequestError ? error.retryAfterMs : undefined;
      await abortableDelay(retryAfterMs ?? retryBackoffMs(attempt), input.signal);
    }
  }

  throw lastError ?? new Error('WebSearch provider "tencent_wsa" failed.');
}

async function requestTencentWsa(
  config: WebSearchProviderConfig,
  input: WebSearchInput,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 8_000);
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchImpl(config.endpoint || DEFAULT_TENCENT_WSA_ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(buildTencentWsaRequest(input)),
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
      const apiError = extractTencentWsaError(payload);
      throw new TencentWsaRequestError(
        `WebSearch provider "tencent_wsa" failed with HTTP ${response.status}: ${apiError?.message ?? extractError(payload, text)}`,
        {
          status: response.status,
          code: apiError?.code,
          retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        },
      );
    }
    return payload;
  } catch (error) {
    if (input.signal?.aborted) throw error;
    if (error instanceof TencentWsaRequestError) throw error;
    throw new TencentWsaRequestError(
      `WebSearch provider "tencent_wsa" request failed: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'TransportError' },
    );
  } finally {
    clearTimeout(timeout);
  }
}

function buildTencentWsaRequest(input: WebSearchInput): Record<string, unknown> {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const body: Record<string, unknown> = {
    Query: input.query,
    Mode: 0,
  };
  if (input.freshness) {
    body.FromTime = nowSeconds - freshnessSeconds(input.freshness);
    body.ToTime = nowSeconds;
  }
  if (input.allowedDomains?.length === 1) {
    const site = normalizeHostname(input.allowedDomains[0]);
    if (site) body.Site = site;
  }
  return body;
}

function normalizeTencentWsaResults(payload: unknown): WebSearchResultItem[] {
  const response = getObject(getObject(payload).Response);
  const pages = Array.isArray(response.Pages) ? response.Pages : [];
  return pages.flatMap((raw) => {
    let item: Record<string, unknown>;
    if (typeof raw === 'string') {
      try {
        item = getObject(JSON.parse(raw));
      } catch {
        return [];
      }
    } else {
      item = getObject(raw);
    }
    const title = firstString(item.title, item.Title);
    const url = firstString(item.url, item.Url, item.URL);
    if (!title || !url) return [];
    const result: WebSearchResultItem = { title, url };
    const snippet = firstString(item.content, item.passage, item.snippet, item.summary);
    if (snippet) result.snippet = snippet;
    const publishedAt = firstString(item.date, item.publishedAt, item.PublishTime);
    if (publishedAt) result.publishedAt = publishedAt;
    const source = firstString(item.site, item.source, item.SiteName);
    if (source) result.source = source;
    return [result];
  });
}

function filterTencentWsaResults(
  results: WebSearchResultItem[],
  allowedDomains?: string[],
  blockedDomains?: string[],
): WebSearchResultItem[] {
  const allowed = (allowedDomains ?? []).map(normalizeHostname).filter((host): host is string => !!host);
  const blocked = (blockedDomains ?? []).map(normalizeHostname).filter((host): host is string => !!host);
  if (allowed.length <= 1 && blocked.length === 0) return results;
  return results.filter((result) => {
    let hostname: string;
    try {
      hostname = new URL(result.url).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (allowed.length > 1 && !allowed.some((domain) => hostMatches(hostname, domain))) return false;
    return !blocked.some((domain) => hostMatches(hostname, domain));
  });
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

function extractTencentWsaError(payload: unknown): { code?: string; message: string } | undefined {
  const response = getObject(getObject(payload).Response);
  const error = getObject(response.Error);
  const code = firstString(error.Code, error.code);
  const message = firstString(error.Message, error.message);
  if (!code && !message) return undefined;
  return {
    ...(code ? { code } : {}),
    message: [code, message].filter(Boolean).join(': '),
  };
}

class TencentWsaRequestError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, options: { status?: number; code?: string; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'TencentWsaRequestError';
    if (options.status !== undefined) this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

function isRetryableTencentWsaError(error: unknown): boolean {
  if (!(error instanceof TencentWsaRequestError)) return false;
  if (error.code === 'RequestLimitExceeded' || error.code === 'TransportError') return true;
  return error.status === 408
    || error.status === 425
    || error.status === 429
    || error.status === 500
    || error.status === 502
    || error.status === 503
    || error.status === 504;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - Date.now());
}

function retryBackoffMs(attempt: number): number {
  const cap = attempt === 1 ? 500 : 1_500;
  return Math.floor(Math.random() * cap);
}

function freshnessSeconds(freshness: NonNullable<WebSearchInput['freshness']>): number {
  switch (freshness) {
    case 'day': return 24 * 60 * 60;
    case 'week': return 7 * 24 * 60 * 60;
    case 'month': return 30 * 24 * 60 * 60;
    case 'year': return 365 * 24 * 60 * 60;
  }
}

function normalizeHostname(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

class RequestPacer {
  private nextAt = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly intervalMs: number) {}

  wait(signal?: AbortSignal): Promise<void> {
    const scheduled = this.tail.then(async () => {
      const now = Date.now();
      const startAt = Math.max(now, this.nextAt);
      this.nextAt = startAt + this.intervalMs;
      await abortableDelay(startAt - now, signal);
    });
    this.tail = scheduled.catch(() => undefined);
    return scheduled;
  }
}

/** 腾讯默认额度为 20 QPS；留 10% 余量并平滑请求，避免子 Agent fan-out 形成瞬时尖峰。 */
const tencentWsaPacer = new RequestPacer(TENCENT_WSA_REQUEST_INTERVAL_MS);

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('The operation was aborted.'));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error('The operation was aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
