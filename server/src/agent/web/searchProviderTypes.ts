import type { WebEgressPolicy } from './ssrf.js';

/** 国内源与国外源分列：cn 走中文索引（智谱/腾讯/火山），global 走境外索引（Tavily/Brave）。 */
export type WebSearchScope = 'cn' | 'global';

export type WebSearchProviderId = 'brave' | 'volcengine' | 'tencent_wsa' | 'zhipu' | 'tavily';

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
  /**
   * 部分中文内容源（智谱侧的公众号类来源）只给正文不给原文链接。这类结果内容完整、
   * 时效性强，整类丢弃会让「Anthropic Claude 最新模型」这种查询返回 0 条，
   * 因此保留但不带 url；调用方据此判断能否交给 WebFetch 取全文。
   */
  url?: string;
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
  /** 智谱计费档位：search_std ¥0.01/次、search_pro ¥0.03/次。仅 zhipu 使用。 */
  searchEngine?: string;
  /** Tavily 检索深度：basic=1 credit、advanced=2 credits。仅 tavily 使用。 */
  searchDepth?: 'basic' | 'advanced';
  /** 火山账号级服务端排队，避免多 Worker 瞬时请求直接触发 QPS 限流。 */
  enableWaiting?: boolean;
  maxWaitTimeMs?: number;
}

export interface WebSearchOutput {
  provider: WebSearchProviderId;
  query: string;
  results: WebSearchResultItem[];
  fetchedAt: string;
  truncated: boolean;
  diagnostics?: {
    attempts: number;
    tookMs: number;
    requestId?: string;
    logId?: string;
  };
}

/** 输入不满足搜索源约束，不计入服务故障，也不触发备用源调用。 */
export class WebSearchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebSearchInputError';
  }
}
