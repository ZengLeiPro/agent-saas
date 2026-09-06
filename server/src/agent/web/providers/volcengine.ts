import { setTimeout as delay } from 'node:timers/promises';

import type {
  WebSearchInput,
  WebSearchOutput,
  WebSearchProviderConfig,
  WebSearchResultItem,
} from '../searchProviderTypes.js';
import { WebSearchInputError } from '../searchProviderTypes.js';
import { clamp, firstString, getObject } from '../searchProviderUtils.js';

const ENDPOINT = 'https://open.feedcoopapi.com/search_api/web_search';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS_BYTES = 48_000;
const RETRYABLE_CODES = new Set(['700429', '10500']);

class VolcengineSearchError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly requestId?: string,
    readonly retryAfterMs?: number,
  ) {
    super(
      `WebSearch provider "volcengine" failed: ${code}${status ? ` (HTTP ${status})` : ''}${requestId ? ` requestId=${requestId}` : ''}`,
    );
    this.name = 'VolcengineSearchError';
  }
}

/** Agent Plan 与普通 Custom Key 共用协议；抵扣由火山账号设置决定。 */
export async function runVolcengineSearch(
  config: WebSearchProviderConfig,
  input: WebSearchInput,
  fetchImpl: typeof fetch,
): Promise<WebSearchOutput> {
  input.signal?.throwIfAborted();
  if (!config.apiKey)
    throw new Error('WebSearch provider "volcengine" is missing apiKey/apiKeyRef.');
  if (!input.query.trim() || Array.from(input.query).length > 100) {
    throw new WebSearchInputError('豆包搜索 query 必须为 1～100 个字符，请缩短搜索词后重试。');
  }
  const count = clamp(input.count, 1, Math.min(config.maxResults ?? 10, 10));
  const body = JSON.stringify(buildRequest(config, input, count));
  const startedAt = Date.now();
  const timeoutMs = config.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  try {
    for (let attempt = 1; ; attempt += 1) {
      signal.throwIfAborted();
      try {
        const response = await fetchImpl(config.endpoint || ENDPOINT, {
          method: 'POST',
          signal,
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body,
        });
        const text = await readBoundedResponse(response);
        signal.throwIfAborted();
        let payload: Record<string, unknown> = {};
        try {
          payload = getObject(JSON.parse(text));
        } catch {
          if (response.ok) throw new VolcengineSearchError('INVALID_RESPONSE');
        }
        const metadata = getObject(payload.ResponseMetadata);
        const error = getObject(metadata.Error);
        const rawCode = String(error.Code ?? error.code ?? '');
        const code = /^\d{3,8}$/.test(rawCode) ? rawCode : undefined;
        const requestId = safeId(metadata.RequestId, config.apiKey);
        if (!response.ok || Object.keys(error).length > 0) {
          // 不透传服务端原始 message/body，避免代理回显凭据或大段 HTML。
          throw new VolcengineSearchError(
            code ?? 'HTTP_ERROR',
            response.status,
            requestId,
            retryAfter(response.headers.get('retry-after')),
          );
        }
        const result = getObject(payload.Result);
        if (!Array.isArray(result.WebResults) && result.ResultCount !== 0) {
          throw new VolcengineSearchError('INVALID_RESPONSE', response.status, requestId);
        }
        const normalized = normalizeResults(result, count);
        return {
          provider: 'volcengine',
          query: input.query,
          ...normalized,
          fetchedAt: new Date().toISOString(),
          diagnostics: {
            attempts: attempt,
            tookMs: Date.now() - startedAt,
            ...(requestId ? { requestId } : {}),
            ...(safeId(result.LogId, config.apiKey)
              ? { logId: safeId(result.LogId, config.apiKey) }
              : {}),
          },
        };
      } catch (error) {
        if (signal.aborted) {
          if (input.signal?.aborted) throw input.signal.reason;
          throw new VolcengineSearchError('TIMEOUT');
        }
        if (!(error instanceof VolcengineSearchError))
          throw new VolcengineSearchError('TRANSPORT_ERROR');
        const retryable =
          RETRYABLE_CODES.has(error.code) ||
          (error.code === 'HTTP_ERROR' && [429, 500, 502, 503, 504].includes(error.status ?? 0));
        if (attempt >= 2 || !retryable) throw error;
        const waitMs = error.retryAfterMs ?? 250 + Math.floor(Math.random() * 250);
        if (Date.now() - startedAt + waitMs >= timeoutMs) throw error;
        await delay(waitMs, undefined, { signal });
      }
    }
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    if (controller.signal.aborted) throw new VolcengineSearchError('TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildRequest(
  config: WebSearchProviderConfig,
  input: WebSearchInput,
  count: number,
): Record<string, unknown> {
  const filter: Record<string, unknown> = { NeedUrl: true };
  const sites = formatHosts(input.allowedDomains, 20);
  const blocked = formatHosts(input.blockedDomains, 5);
  if (sites) filter.Sites = sites;
  if (blocked) filter.BlockHosts = blocked;
  return {
    Query: input.query,
    SearchType: 'web',
    Count: count,
    Filter: filter,
    ContentFormats: 'markdown',
    EnableWaiting: config.enableWaiting ?? true,
    ...(config.enableWaiting !== false ? { MaxWaitTime: config.maxWaitTimeMs ?? 5_000 } : {}),
    ...(input.freshness
      ? {
          TimeRange: { day: 'OneDay', week: 'OneWeek', month: 'OneMonth', year: 'OneYear' }[
            input.freshness
          ],
        }
      : {}),
  };
}

function formatHosts(hosts: string[] | undefined, limit: number): string | undefined {
  const values = (hosts ?? [])
    .map((host) =>
      host
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, ''),
    )
    .filter(Boolean);
  if (values.length > limit)
    throw new WebSearchInputError(`豆包搜索域名过滤最多支持 ${limit} 个域名，请缩小范围。`);
  return values.length > 0 ? values.join('|') : undefined;
}

function normalizeResults(
  result: Record<string, unknown>,
  count: number,
): Pick<WebSearchOutput, 'results' | 'truncated'> {
  const rawResults = Array.isArray(result.WebResults) ? result.WebResults : [];
  const results: WebSearchResultItem[] = [];
  let truncated = rawResults.length > count || Number(result.ResultCount) > count;
  let bytes = 2;
  const bounded = (value: string, limit: number) => {
    if (value.length <= limit) return value;
    truncated = true;
    return `${value.slice(0, limit - 1)}…`;
  };
  for (const raw of rawResults) {
    const item = getObject(raw);
    const title = firstString(item.Title, item.title);
    const url = firstString(item.Url, item.URL, item.url);
    if (!title || !url) continue;
    // URL 不截断，避免构造出不存在的引用地址。
    if (url.length > 2048) {
      truncated = true;
      continue;
    }
    const normalized: WebSearchResultItem = { title: bounded(title, 512), url };
    const summary = firstString(item.Summary, item.Snippet, item.Description, item.Content);
    if (summary) normalized.snippet = bounded(summary, 2000);
    const publishedAt = firstString(item.PublishTime, item.PublishedAt, item.publishedAt);
    if (publishedAt) normalized.publishedAt = bounded(publishedAt, 128);
    const source = firstString(item.SiteName, item.Source, item.source);
    if (source) normalized.source = bounded(source, 128);
    bytes += Buffer.byteLength(JSON.stringify(normalized)) + 1;
    if (bytes > MAX_RESULTS_BYTES) {
      truncated = true;
      break;
    }
    results.push(normalized);
    if (results.length === count) break;
  }
  return { results, truncated };
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new VolcengineSearchError('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

function safeId(value: unknown, apiKey: string): string | undefined {
  return typeof value === 'string'
    ? value
        .split(apiKey)
        .join('[redacted]')
        .replace(/[\r\n]/g, '')
        .slice(0, 128)
    : undefined;
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}
