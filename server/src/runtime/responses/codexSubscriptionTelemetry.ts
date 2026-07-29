import type { ModelTerminalStatus, ModelUsage } from '../types.js';

const REQUEST_SAMPLE_LIMIT = 50;

export interface CodexSubscriptionRuntimeStatus {
  requestWindow: {
    limit: number;
    sampleCount: number;
    eligibleRequestCount: number;
    cacheHitRequestCount: number;
    eligibleInputTokens: number;
    cachedInputTokens: number;
    cacheHitRequestRate?: number;
    cachedInputTokenRate?: number;
  };
  lastRequestAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  lastModel?: string;
  oauth: {
    lastRefreshAt?: string;
    lastRefreshGeneration?: number;
    lastRefreshErrorAt?: string;
    lastRefreshError?: string;
  };
}

interface RequestSample {
  timestamp: string;
  model: string;
  terminalStatus: ModelTerminalStatus;
  inputTokens: number;
  cachedInputTokens: number;
  cacheEligible: boolean;
  error?: string;
}

/**
 * 当前 Server 实例的轻量运行健康窗口。
 *
 * 不写 PG：这里只用于管理员即时判断刚完成的 canary 是否命中缓存、OAuth 是否刷新成功。
 * 跨实例/长期分析继续以 PG runtime events 与 usage 账本为事实源。
 */
export class CodexSubscriptionTelemetry {
  private readonly requests: RequestSample[] = [];
  private lastRefreshAt?: string;
  private lastRefreshGeneration?: number;
  private lastRefreshErrorAt?: string;
  private lastRefreshError?: string;

  recordResult(input: {
    model: string;
    terminalStatus: ModelTerminalStatus;
    usage?: ModelUsage;
    cacheEligible?: boolean;
    errorCode?: string;
  }): void {
    const failed = input.terminalStatus !== 'completed';
    this.pushRequest({
      timestamp: new Date().toISOString(),
      model: input.model,
      terminalStatus: input.terminalStatus,
      inputTokens: nonNegativeInt(input.usage?.inputTokens),
      cachedInputTokens: nonNegativeInt(input.usage?.cacheReadInputTokens),
      cacheEligible: input.cacheEligible === true,
      ...(failed ? { error: compactTelemetryError(input.errorCode ?? input.terminalStatus) } : {}),
    });
  }

  recordFailure(model: string, error: unknown): void {
    this.pushRequest({
      timestamp: new Date().toISOString(),
      model,
      terminalStatus: 'failed',
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheEligible: false,
      error: compactTelemetryError(error),
    });
  }

  recordRefreshSuccess(generation: number): void {
    this.lastRefreshAt = new Date().toISOString();
    this.lastRefreshGeneration = generation;
    this.lastRefreshErrorAt = undefined;
    this.lastRefreshError = undefined;
  }

  recordRefreshFailure(error: unknown): void {
    this.lastRefreshErrorAt = new Date().toISOString();
    this.lastRefreshError = compactTelemetryError(error);
  }

  snapshot(): CodexSubscriptionRuntimeStatus {
    const eligible = this.requests.filter((sample) => sample.cacheEligible);
    const cacheHitRequestCount = eligible.filter((sample) => sample.cachedInputTokens > 0).length;
    const eligibleInputTokens = eligible.reduce((sum, sample) => sum + sample.inputTokens, 0);
    const cachedInputTokens = eligible.reduce((sum, sample) => sum + sample.cachedInputTokens, 0);
    const last = this.requests.at(-1);
    const lastSuccess = findLast(this.requests, (sample) => sample.terminalStatus === 'completed');
    const lastError = findLast(this.requests, (sample) => sample.terminalStatus !== 'completed');
    return {
      requestWindow: {
        limit: REQUEST_SAMPLE_LIMIT,
        sampleCount: this.requests.length,
        eligibleRequestCount: eligible.length,
        cacheHitRequestCount,
        eligibleInputTokens,
        cachedInputTokens,
        ...(eligible.length > 0
          ? { cacheHitRequestRate: cacheHitRequestCount / eligible.length }
          : {}),
        ...(eligibleInputTokens > 0
          ? { cachedInputTokenRate: Math.min(1, cachedInputTokens / eligibleInputTokens) }
          : {}),
      },
      ...(last ? { lastRequestAt: last.timestamp, lastModel: last.model } : {}),
      ...(lastSuccess ? { lastSuccessAt: lastSuccess.timestamp } : {}),
      ...(lastError
        ? {
          lastErrorAt: lastError.timestamp,
          lastError: lastError.error ?? lastError.terminalStatus,
        }
        : {}),
      oauth: {
        ...(this.lastRefreshAt ? { lastRefreshAt: this.lastRefreshAt } : {}),
        ...(this.lastRefreshGeneration !== undefined
          ? { lastRefreshGeneration: this.lastRefreshGeneration }
          : {}),
        ...(this.lastRefreshErrorAt ? { lastRefreshErrorAt: this.lastRefreshErrorAt } : {}),
        ...(this.lastRefreshError ? { lastRefreshError: this.lastRefreshError } : {}),
      },
    };
  }

  private pushRequest(sample: RequestSample): void {
    this.requests.push(sample);
    if (this.requests.length > REQUEST_SAMPLE_LIMIT) {
      this.requests.splice(0, this.requests.length - REQUEST_SAMPLE_LIMIT);
    }
  }
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return item;
  }
  return undefined;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function compactTelemetryError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access|refresh|id)[_-]?token["'\s:=]+)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240) || 'unknown_error';
}
