import type {
  WebSearchInput,
  WebSearchOutput,
  WebSearchProviderConfig,
  WebSearchResultItem,
} from '../searchProviderTypes.js';
import { clamp, extractError, firstString, getObject } from '../searchProviderUtils.js';

export const DEFAULT_TAVILY_ENDPOINT = 'https://api.tavily.com/search';

/** Tavily `content` 是 LLM 导向的摘录，通常已较短；仍设上限避免个别长页拖大上下文。 */
const TAVILY_SNIPPET_MAX_CHARS = 800;

/**
 * Tavily 境外搜索。域名过滤走服务端 include/exclude_domains（原生支持，无需本地兜底）。
 * 计费按 credit：basic=1、advanced=2，免费档每月 1000 credits。
 */
export async function runTavilySearch(
  config: WebSearchProviderConfig,
  input: WebSearchInput,
  fetchImpl: typeof fetch,
): Promise<WebSearchOutput> {
  if (!config.apiKey) {
    throw new Error('WebSearch provider "tavily" is missing apiKey/apiKeyRef.');
  }
  const count = clamp(input.count, 1, config.maxResults ?? 10);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 8_000);
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchImpl(config.endpoint || DEFAULT_TAVILY_ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildTavilyRequest(config, input, count)),
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
      throw new Error(`WebSearch provider "tavily" failed with HTTP ${response.status}: ${extractError(payload, text)}`);
    }
    const allResults = normalizeTavilyResults(payload);
    return {
      provider: 'tavily',
      query: input.query,
      results: allResults.slice(0, count),
      fetchedAt: new Date().toISOString(),
      truncated: allResults.length > count,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildTavilyRequest(
  config: WebSearchProviderConfig,
  input: WebSearchInput,
  count: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: input.query,
    max_results: count,
    search_depth: config.searchDepth || 'basic',
  };
  if (input.allowedDomains?.length) body.include_domains = input.allowedDomains;
  if (input.blockedDomains?.length) body.exclude_domains = input.blockedDomains;
  const days = mapTavilyDays(input.freshness);
  if (days) {
    body.topic = 'news';
    body.days = days;
  }
  return body;
}

/** Tavily 时效过滤仅在 topic=news 下按天生效，没有通用的 freshness 参数。 */
function mapTavilyDays(freshness: WebSearchInput['freshness']): number | undefined {
  switch (freshness) {
    case 'day': return 1;
    case 'week': return 7;
    case 'month': return 30;
    case 'year': return 365;
    default: return undefined;
  }
}

function normalizeTavilyResults(payload: unknown): WebSearchResultItem[] {
  const root = getObject(payload);
  const results = Array.isArray(root.results) ? root.results : [];
  return results.flatMap((raw) => {
    const item = getObject(raw);
    const title = firstString(item.title);
    const url = firstString(item.url);
    if (!title || !url) return [];
    const normalized: WebSearchResultItem = { title, url };
    const snippet = firstString(item.content);
    if (snippet) {
      normalized.snippet = snippet.length > TAVILY_SNIPPET_MAX_CHARS
        ? `${snippet.slice(0, TAVILY_SNIPPET_MAX_CHARS)}…`
        : snippet;
    }
    const publishedAt = firstString(item.published_date);
    if (publishedAt) normalized.publishedAt = publishedAt;
    return [normalized];
  });
}
