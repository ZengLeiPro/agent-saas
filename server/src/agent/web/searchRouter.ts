import { WebSearchInputError } from './searchProviderTypes.js';
import { runWebSearch } from './searchProviders.js';
import type {
  WebSearchInput,
  WebSearchOutput,
  WebSearchProviderConfig,
  WebSearchScope,
} from './searchProviderTypes.js';

/**
 * 国内/国外双源配置。`search` 本身是国内主源（保持既有单 provider 语义向后兼容），
 * `global` 是可选的境外源；未配置 global 时 scope=global 自动回落到主源。
 */
export interface WebSearchRoutingConfig extends WebSearchProviderConfig {
  global?: WebSearchProviderConfig;
}

export interface RoutedSearchOutcome extends WebSearchOutput {
  /** 模型请求的 scope；与实际 provider 不一致即说明发生了降级。 */
  requestedScope: WebSearchScope;
  degraded: boolean;
  /** 降级时保留首选源的失败原因，便于诊断与告警。 */
  primaryError?: string;
}

/**
 * provider 连续失败观测。2026-07-28 腾讯 WSA 欠费导致全租户搜索静默失败 19 天无人发现，
 * 因此把「连续失败」升级为显式告警信号，而不是只落在 tool_audit 里等人去查。
 */
export const SEARCH_PROVIDER_ALERT_THRESHOLD = 5;

export type SearchProviderAlertHandler = (alert: {
  provider: string;
  consecutiveFailures: number;
  lastError: string;
}) => void;

const consecutiveFailures = new Map<string, number>();
let alertHandler: SearchProviderAlertHandler | undefined;

export function setSearchProviderAlertHandler(handler: SearchProviderAlertHandler | undefined): void {
  alertHandler = handler;
}

/** 仅供测试重置模块级计数。 */
export function resetSearchProviderFailureState(): void {
  consecutiveFailures.clear();
}

function recordSuccess(provider: string): void {
  consecutiveFailures.delete(provider);
}

function recordFailure(provider: string, error: unknown): void {
  const next = (consecutiveFailures.get(provider) ?? 0) + 1;
  consecutiveFailures.set(provider, next);
  // 达到阈值后每次失败都上报，去重交给 AlertNotifier 的 dedupeKey/重复间隔。
  if (next >= SEARCH_PROVIDER_ALERT_THRESHOLD && alertHandler) {
    alertHandler({
      provider,
      consecutiveFailures: next,
      lastError: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveScopeConfig(
  config: WebSearchRoutingConfig,
  scope: WebSearchScope,
): { primary: WebSearchProviderConfig; fallback?: WebSearchProviderConfig } {
  const { global: globalConfig, ...cnConfig } = config;
  const globalUsable = !!globalConfig?.apiKey;
  if (scope === 'global') {
    if (!globalUsable) return { primary: cnConfig };
    return { primary: { ...globalConfig, egress: globalConfig.egress ?? cnConfig.egress }, fallback: cnConfig };
  }
  if (!globalUsable) return { primary: cnConfig };
  return {
    primary: cnConfig,
    fallback: { ...globalConfig, egress: globalConfig.egress ?? cnConfig.egress },
  };
}

/**
 * 按 scope 选源并在首选源失败时降级到另一侧。工具层始终只暴露单一 WebSearch，
 * 供应商选择、熔断与降级全部收敛在服务端（与 Claude Code / Codex 的做法一致）。
 */
export async function runRoutedWebSearch(
  config: WebSearchRoutingConfig,
  input: WebSearchInput,
  scope: WebSearchScope,
  fetchImpl: typeof fetch = fetch,
): Promise<RoutedSearchOutcome> {
  const { primary, fallback } = resolveScopeConfig(config, scope);
  const primaryId = primary.provider ?? 'volcengine';
  try {
    const output = await runWebSearch(primary, input, fetchImpl);
    recordSuccess(primaryId);
    return { ...output, requestedScope: scope, degraded: false };
  } catch (error) {
    // 调用方主动取消不算 provider 故障，也不该触发降级重试。
    if (input.signal?.aborted || error instanceof WebSearchInputError) throw error;
    recordFailure(primaryId, error);
    if (!fallback) throw error;

    const fallbackId = fallback.provider ?? 'volcengine';
    const primaryError = error instanceof Error ? error.message : String(error);
    try {
      const output = await runWebSearch(fallback, input, fetchImpl);
      recordSuccess(fallbackId);
      return { ...output, requestedScope: scope, degraded: true, primaryError };
    } catch (fallbackError) {
      if (input.signal?.aborted || fallbackError instanceof WebSearchInputError) throw fallbackError;
      recordFailure(fallbackId, fallbackError);
      const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`WebSearch 两个来源均失败。首选(${primaryId})：${primaryError}；备用(${fallbackId})：${message}`, {
        cause: fallbackError,
      });
    }
  }
}
