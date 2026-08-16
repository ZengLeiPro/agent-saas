import type {
  WebSearchInput,
  WebSearchOutput,
  WebSearchProviderConfig,
  WebSearchResultItem,
} from '../searchProviderTypes.js';
import { clamp, extractError, filterByDomains, firstString, getObject } from '../searchProviderUtils.js';

export const DEFAULT_ZHIPU_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/web_search';

/** 智谱 `search_std` 返回整篇正文而非摘要，单条可达数千字；不截断会让一次搜索吃掉数万 token。 */
const ZHIPU_SNIPPET_MAX_CHARS = 600;
/** 无源链接的结果无法再用 WebFetch 取全文，正文即全部信息，给更宽的额度。 */
const ZHIPU_LINKLESS_SNIPPET_MAX_CHARS = 1_200;

/**
 * 智谱联网搜索。`search_engine` 决定计费档位（search_std ¥0.01/次、search_pro ¥0.03/次），
 * 平台默认 std；域名过滤智谱侧不支持，统一在本地按 URL 过滤。
 */
export async function runZhipuSearch(
  config: WebSearchProviderConfig,
  input: WebSearchInput,
  fetchImpl: typeof fetch,
): Promise<WebSearchOutput> {
  if (!config.apiKey) {
    throw new Error('WebSearch provider "zhipu" is missing apiKey/apiKeyRef.');
  }
  const count = clamp(input.count, 1, config.maxResults ?? 10);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 8_000);
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchImpl(config.endpoint || DEFAULT_ZHIPU_ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildZhipuRequest(config, input, count)),
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
      throw new Error(`WebSearch provider "zhipu" failed with HTTP ${response.status}: ${extractError(payload, text)}`);
    }
    const apiError = extractZhipuError(payload);
    if (apiError) {
      throw new Error(`WebSearch provider "zhipu" failed: ${apiError}`);
    }
    const allResults = filterByDomains(normalizeZhipuResults(payload), input.allowedDomains, input.blockedDomains);
    return {
      provider: 'zhipu',
      query: input.query,
      results: allResults.slice(0, count),
      fetchedAt: new Date().toISOString(),
      truncated: allResults.length > count,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildZhipuRequest(
  config: WebSearchProviderConfig,
  input: WebSearchInput,
  count: number,
): Record<string, unknown> {
  return {
    search_engine: config.searchEngine || 'search_std',
    search_query: input.query,
    count,
    ...(input.freshness ? { search_recency_filter: mapZhipuRecency(input.freshness) } : {}),
  };
}

function mapZhipuRecency(freshness: NonNullable<WebSearchInput['freshness']>): string {
  switch (freshness) {
    case 'day': return 'oneDay';
    case 'week': return 'oneWeek';
    case 'month': return 'oneMonth';
    case 'year': return 'oneYear';
  }
}

function normalizeZhipuResults(payload: unknown): WebSearchResultItem[] {
  const root = getObject(payload);
  const results = Array.isArray(root.search_result) ? root.search_result : [];
  return results.flatMap((raw) => {
    const item = getObject(raw);
    const title = firstString(item.title);
    if (!title) return [];
    // link 为空的多是公众号类来源：正文完整但不给原文地址。保留内容、不伪造 URL。
    const url = firstString(item.link, item.url);
    const normalized: WebSearchResultItem = { title, ...(url ? { url } : {}) };
    const snippet = firstString(item.content, item.snippet);
    if (snippet) {
      // 无源链接的结果不能靠 WebFetch 补全，正文是唯一信息载体，放宽截断上限。
      const limit = url ? ZHIPU_SNIPPET_MAX_CHARS : ZHIPU_LINKLESS_SNIPPET_MAX_CHARS;
      normalized.snippet = snippet.length > limit ? `${snippet.slice(0, limit)}…` : snippet;
    }
    const publishedAt = firstString(item.publish_date);
    if (publishedAt) normalized.publishedAt = publishedAt;
    const source = firstString(item.media);
    if (source) normalized.source = source;
    return [normalized];
  });
}

function extractZhipuError(payload: unknown): string | undefined {
  const error = getObject(getObject(payload).error);
  const code = firstString(error.code);
  const message = firstString(error.message);
  if (!code && !message) return undefined;
  return [code, message].filter(Boolean).join(': ');
}
