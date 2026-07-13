import { computeUsageTotalTokens, getUsageAccountingMode } from '../data/usage/pricing.js';
import type { ModelUsage, PlatformEvent } from './types.js';

function nonNegativeInt(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * 会话当前上下文累计器。
 *
 * - 全量请求：provider usage 已是当前完整 prompt，直接重锚到本 leg。
 * - Responses 接力：本 leg 只携带增量；cache_read 是 input 的子集且已存在于
 *   旧上下文，净新增为 (input - cache_read) + output。
 * - 存量事件没有 responseChained 字段时，沿用旧版 cache_read 启发式，等下一次
 *   带显式字段的全量请求自动重锚。
 */
export class ContextTokenAccumulator {
  private currentTokens = 0;
  private sawUsage = false;
  private lastModel: string | undefined;

  reset(): void {
    this.currentTokens = 0;
    this.sawUsage = false;
    this.lastModel = undefined;
  }

  apply(model: string, usage: ModelUsage, responseChained?: boolean): number {
    const inputTokens = nonNegativeInt(usage.inputTokens);
    const outputTokens = nonNegativeInt(usage.outputTokens);
    const cacheReadTokens = nonNegativeInt(usage.cacheReadInputTokens);
    const cacheCreationTokens = nonNegativeInt(usage.cacheCreationInputTokens);
    if (inputTokens <= 0 && outputTokens <= 0) return this.currentTokens;

    const modelChanged = this.sawUsage && this.lastModel !== model;
    const mode = getUsageAccountingMode(model);
    if (mode === 'cache_tokens_separate') {
      this.currentTokens = computeUsageTotalTokens(model, {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      });
    } else if (!this.sawUsage || modelChanged || responseChained === false) {
      this.currentTokens = inputTokens + outputTokens;
    } else if (responseChained === true) {
      this.currentTokens += Math.max(0, inputTokens - cacheReadTokens) + outputTokens;
    } else if (cacheReadTokens === 0) {
      // 兼容 2026-07-14 之前没有 responseChained 的事件：cache miss 视为全量重锚。
      this.currentTokens = inputTokens + outputTokens;
    } else {
      this.currentTokens += Math.max(0, inputTokens - cacheReadTokens) + outputTokens;
    }

    this.sawUsage = true;
    this.lastModel = model;
    return this.currentTokens;
  }

  get value(): number {
    return this.currentTokens;
  }
}

/** 从 durable 事件重建当前上下文；compaction 是硬重置点。 */
export function calculateCurrentContextTokens(
  events: PlatformEvent[],
  defaultModel: string,
): number | null {
  const accumulator = new ContextTokenAccumulator();
  let hasUsage = false;
  for (const event of events) {
    if (event.type === 'compaction') {
      accumulator.reset();
      hasUsage = false;
      continue;
    }
    if ((event.type !== 'assistant_message' && event.type !== 'assistant_tool_calls') || !event.usage) {
      continue;
    }
    const inputTokens = nonNegativeInt(event.usage.inputTokens);
    const outputTokens = nonNegativeInt(event.usage.outputTokens);
    if (inputTokens <= 0 && outputTokens <= 0) continue;
    accumulator.apply(event.model ?? defaultModel, event.usage, event.responseChained);
    hasUsage = true;
  }
  return hasUsage ? accumulator.value : null;
}
