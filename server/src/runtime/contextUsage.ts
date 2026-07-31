import type {
  ContextUsageBreakdown,
  ContextUsageData,
} from '../types/index.js';
import {
  computeCacheHitDenominatorTokens,
  computeUsageTotalTokens,
  getModelAutoCompactThreshold,
  getModelContextWindow,
} from '../data/usage/pricing.js';
import { ContextTokenAccumulator } from './contextAccounting.js';
import type { ModelResponseMode, ModelUsage, PlatformEvent } from './types.js';

interface UsageAccumulator {
  contextTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalReasoningTokens: number;
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

export class RuntimeContextUsageTracker {
  private readonly contextAccumulator = new ContextTokenAccumulator();
  private readonly state: UsageAccumulator = {
    contextTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalReasoningTokens: 0,
    totalTokens: 0,
    cacheHitDenominatorTokens: 0,
    hasUsage: false,
  };

  private latestBreakdown: ContextUsageBreakdown | undefined;
  private latestMemoryFiles: ContextUsageData['memoryFiles'] = [];
  private latestMcpTools: ContextUsageData['mcpTools'] = [];

  constructor(
    private readonly defaultModel: string,
    priorEvents: PlatformEvent[],
    private readonly modelRef?: string,
  ) {
    for (const event of priorEvents) {
      if (event.type === 'compaction') {
        this.contextAccumulator.reset();
        this.state.contextTokens = 0;
        continue;
      }
      if ((event.type === 'assistant_message' || event.type === 'assistant_tool_calls') && event.usage) {
        this.applyUsage(
          event.model ?? defaultModel,
          event.usage,
          event.responseMode,
          event.responseChained,
        );
        if (event.contextBreakdown) {
          this.latestBreakdown = event.contextBreakdown;
          this.latestMemoryFiles = event.contextBreakdown.memoryFiles ?? [];
          this.latestMcpTools = event.contextBreakdown.mcpTools ?? [];
        }
      }
    }
  }

  previewCurrentContextTokens(
    model: string,
    usage: ModelUsage,
    responseMode?: ModelResponseMode,
    responseChained?: boolean,
  ): number {
    return this.contextAccumulator.preview(model, usage, responseMode, responseChained);
  }

  record(
    model: string,
    usage: ModelUsage | undefined,
    responseMode?: ModelResponseMode,
    responseChained?: boolean,
    snapshot?: {
      breakdown: ContextUsageBreakdown;
      memoryFiles: ContextUsageData['memoryFiles'];
      mcpTools: ContextUsageData['mcpTools'];
    },
  ): ContextUsageData | null {
    if (snapshot) {
      this.latestBreakdown = snapshot.breakdown;
      this.latestMemoryFiles = snapshot.memoryFiles;
      this.latestMcpTools = snapshot.mcpTools;
    }
    if (!usage) return this.state.hasUsage ? this.toContextUsage(model, null) : null;
    const lastRequest = this.applyUsage(model, usage, responseMode, responseChained);
    if (!this.state.hasUsage) return null;
    return this.toContextUsage(model, lastRequest);
  }

  /** 当前 Responses 接力链或全量请求的上下文 token 口径。 */
  get currentContextTokens(): number {
    return this.state.contextTokens;
  }

  private applyUsage(
    model: string,
    usage: ModelUsage,
    responseMode?: ModelResponseMode,
    responseChained?: boolean,
  ): LastRequestCacheMetrics {
    const inputTokens = nonNegativeInt(usage.inputTokens);
    const outputTokens = nonNegativeInt(usage.outputTokens);
    const cacheReadTokens = nonNegativeInt(usage.cacheReadInputTokens);
    const cacheCreationTokens = nonNegativeInt(usage.cacheCreationInputTokens);
    const reasoningTokens = nonNegativeInt(usage.reasoningTokens);
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
    this.state.totalReasoningTokens += reasoningTokens;
    this.state.totalTokens += turnTotal;
    this.state.cacheHitDenominatorTokens += denominatorTokens;
    this.state.hasUsage = true;

    this.state.contextTokens = this.contextAccumulator.apply(model, usage, responseMode, responseChained);

    return {
      cacheReadTokens,
      denominatorTokens,
      hitRatio: denominatorTokens > 0 ? cacheReadTokens / denominatorTokens : null,
    };
  }

  private toContextUsage(model: string, lastRequest: LastRequestCacheMetrics | null): ContextUsageData {
    const maxTokens = getModelContextWindow(model, this.modelRef);
    const autoCompactThreshold = getModelAutoCompactThreshold(model, this.modelRef);
    const cacheHitRatio = this.state.cacheHitDenominatorTokens > 0
      ? this.state.totalCacheReadTokens / this.state.cacheHitDenominatorTokens
      : null;
    return {
      totalTokens: this.state.contextTokens,
      ...(maxTokens ? {
        maxTokens,
        percentage: this.state.contextTokens / maxTokens,
        autoCompactThreshold,
      } : {}),
      model,
      categories: this.latestBreakdown?.categories.map((item) => ({
        name: item.name,
        tokens: item.tokens,
        color: item.color,
        ...(item.isDeferred !== undefined ? { isDeferred: item.isDeferred } : {}),
      })) ?? [
        { name: '累计输入', tokens: this.state.totalInputTokens, color: '#10b981' },
        { name: '累计缓存读', tokens: this.state.totalCacheReadTokens, color: '#60a5fa' },
        { name: '累计缓存写', tokens: this.state.totalCacheCreationTokens, color: '#a78bfa' },
        { name: '累计输出', tokens: this.state.totalOutputTokens, color: '#f59e0b' },
      ],
      ...(this.latestBreakdown ? { breakdown: this.latestBreakdown } : {}),
      usageTotals: {
        inputTokens: this.state.totalInputTokens,
        uncachedInputTokens: Math.max(0, this.state.totalInputTokens - this.state.totalCacheReadTokens),
        cacheReadTokens: this.state.totalCacheReadTokens,
        cacheCreationTokens: this.state.totalCacheCreationTokens,
        outputTokens: this.state.totalOutputTokens,
        reasoningTokens: this.state.totalReasoningTokens,
      },
      memoryFiles: this.latestMemoryFiles,
      mcpTools: this.latestMcpTools,
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
