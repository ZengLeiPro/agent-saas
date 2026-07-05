import type { ContextUsageData } from '../types/index.js';
import {
  computeCacheHitDenominatorTokens,
  computeUsageTotalTokens,
  getModelContextWindow,
  getUsageAccountingMode,
} from '../data/usage/pricing.js';
import { AUTO_COMPACT_THRESHOLD_RATIO } from './autoCompaction.js';
import type { ModelUsage, PlatformEvent } from './types.js';

interface UsageAccumulator {
  contextTokens: number;
  accumulatingContextTokens: number;
  sawFirstUsage: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalTokens: number;
  cacheHitDenominatorTokens: number;
  hasUsage: boolean;
}

interface LastRequestCacheMetrics {
  cacheReadTokens: number;
  denominatorTokens: number;
  hitRatio: number | null;
}

function nonNegativeInt(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function assistantUsageEvents(events: PlatformEvent[]): Array<{ model: string | undefined; usage: ModelUsage }> {
  const result: Array<{ model: string | undefined; usage: ModelUsage }> = [];
  for (const event of events) {
    if ((event.type === 'assistant_message' || event.type === 'assistant_tool_calls') && event.usage) {
      result.push({ model: event.model, usage: event.usage });
    }
  }
  return result;
}

export class RuntimeContextUsageTracker {
  private readonly state: UsageAccumulator = {
    contextTokens: 0,
    accumulatingContextTokens: 0,
    sawFirstUsage: false,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalTokens: 0,
    cacheHitDenominatorTokens: 0,
    hasUsage: false,
  };

  constructor(
    private readonly defaultModel: string,
    priorEvents: PlatformEvent[],
  ) {
    for (const event of assistantUsageEvents(priorEvents)) {
      this.applyUsage(event.model ?? defaultModel, event.usage);
    }
  }

  record(model: string, usage: ModelUsage | undefined): ContextUsageData | null {
    if (!usage) return this.state.hasUsage ? this.toContextUsage(model, null) : null;
    const lastRequest = this.applyUsage(model, usage);
    if (!this.state.hasUsage) return null;
    return this.toContextUsage(model, lastRequest);
  }

  private applyUsage(model: string, usage: ModelUsage): LastRequestCacheMetrics {
    const inputTokens = nonNegativeInt(usage.inputTokens);
    const outputTokens = nonNegativeInt(usage.outputTokens);
    const cacheReadTokens = nonNegativeInt(usage.cacheReadInputTokens);
    const cacheCreationTokens = nonNegativeInt(usage.cacheCreationInputTokens);
    const tokens = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    };
    const turnTotal = computeUsageTotalTokens(model, tokens);
    const denominatorTokens = computeCacheHitDenominatorTokens(model, tokens);

    this.state.totalInputTokens += inputTokens;
    this.state.totalOutputTokens += outputTokens;
    this.state.totalCacheReadTokens += cacheReadTokens;
    this.state.totalCacheCreationTokens += cacheCreationTokens;
    this.state.totalTokens += turnTotal;
    this.state.cacheHitDenominatorTokens += denominatorTokens;
    this.state.hasUsage = true;

    if (inputTokens > 0 || outputTokens > 0) {
      const mode = getUsageAccountingMode(model);
      if (mode === 'input_includes_cache') {
        if (!this.state.sawFirstUsage || cacheReadTokens === 0) {
          this.state.accumulatingContextTokens = inputTokens + outputTokens;
        } else {
          this.state.accumulatingContextTokens += Math.max(0, inputTokens - cacheReadTokens) + outputTokens;
        }
        this.state.contextTokens = this.state.accumulatingContextTokens;
      } else {
        if (turnTotal > 0) this.state.contextTokens = turnTotal;
        this.state.accumulatingContextTokens = this.state.contextTokens;
      }
      this.state.sawFirstUsage = true;
    }

    return {
      cacheReadTokens,
      denominatorTokens,
      hitRatio: denominatorTokens > 0 ? cacheReadTokens / denominatorTokens : null,
    };
  }

  private toContextUsage(model: string, lastRequest: LastRequestCacheMetrics | null): ContextUsageData {
    const maxTokens = getModelContextWindow(model);
    const cacheHitRatio = this.state.cacheHitDenominatorTokens > 0
      ? this.state.totalCacheReadTokens / this.state.cacheHitDenominatorTokens
      : null;
    return {
      totalTokens: this.state.contextTokens,
      ...(maxTokens ? {
        maxTokens,
        percentage: this.state.contextTokens / maxTokens,
        autoCompactThreshold: AUTO_COMPACT_THRESHOLD_RATIO,
      } : {}),
      model,
      categories: [
        { name: '累计输入', tokens: this.state.totalInputTokens, color: '#10b981' },
        { name: '累计缓存读', tokens: this.state.totalCacheReadTokens, color: '#60a5fa' },
        { name: '累计缓存写', tokens: this.state.totalCacheCreationTokens, color: '#a78bfa' },
        { name: '累计输出', tokens: this.state.totalOutputTokens, color: '#f59e0b' },
      ],
      memoryFiles: [],
      mcpTools: [],
      cacheReadTokens: this.state.totalCacheReadTokens,
      cacheHitDenominatorTokens: this.state.cacheHitDenominatorTokens,
      cacheHitRatio,
      ...(lastRequest ? {
        lastRequestCacheHitRatio: lastRequest.hitRatio,
        lastRequestCacheReadTokens: lastRequest.cacheReadTokens,
        lastRequestCacheHitDenominatorTokens: lastRequest.denominatorTokens,
      } : {}),
    };
  }
}
