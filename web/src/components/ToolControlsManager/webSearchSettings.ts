import type { WebToolsSearchSourceConfig } from '@agent/shared/lib/toolControlsApi';

/** 明确列出可提交字段；凭据状态只用于展示，密钥由后台入库。 */
export function serializeSearchSource(
  source: WebToolsSearchSourceConfig,
  apiKey: string,
): WebToolsSearchSourceConfig {
  for (const [label, value, max] of [
    ['搜索超时', source.timeoutMs, 60_000],
    ['搜索结果数', source.maxResults, 10],
    ['排队等待', source.maxWaitTimeMs, 10_000],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > max)) {
      throw new Error(`${label}必须是 1 到 ${max} 之间的整数`);
    }
  }
  return {
    provider: source.provider ?? 'volcengine',
    ...(source.endpoint?.trim() ? { endpoint: source.endpoint.trim() } : {}),
    ...(apiKey.trim()
      ? { apiKey: apiKey.trim() }
      : source.apiKeyRef?.trim()
        ? { apiKeyRef: source.apiKeyRef.trim() }
        : {}),
    ...(source.timeoutMs !== undefined ? { timeoutMs: source.timeoutMs } : {}),
    ...(source.maxResults !== undefined ? { maxResults: source.maxResults } : {}),
    ...(source.searchEngine ? { searchEngine: source.searchEngine } : {}),
    ...(source.searchDepth ? { searchDepth: source.searchDepth } : {}),
    ...(source.enableWaiting !== undefined ? { enableWaiting: source.enableWaiting } : {}),
    ...(source.maxWaitTimeMs !== undefined ? { maxWaitTimeMs: source.maxWaitTimeMs } : {}),
  };
}
