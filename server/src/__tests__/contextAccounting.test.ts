import { describe, expect, it } from 'vitest';

import { calculateCurrentContextTokens, ContextTokenAccumulator } from '../runtime/contextAccounting.js';
import type { ModelUsage, PlatformEvent } from '../runtime/types.js';

function usage(inputTokens: number, cacheReadInputTokens: number, outputTokens: number): ModelUsage {
  return { inputTokens, cacheReadInputTokens, outputTokens };
}

function assistant(
  index: number,
  model: string,
  modelUsage: ModelUsage,
  responseChained?: boolean,
): PlatformEvent {
  return {
    id: `event-${index}`,
    timestamp: new Date(2026, 6, 14, 0, 0, index).toISOString(),
    type: 'assistant_message',
    runId: `run-${index}`,
    sessionId: 'session-1',
    content: `回复 ${index}`,
    model,
    usage: modelUsage,
    ...(responseChained !== undefined ? { responseChained } : {}),
  };
}

function compaction(index: number): PlatformEvent {
  return {
    id: `compact-${index}`,
    timestamp: new Date(2026, 6, 14, 0, 0, index).toISOString(),
    type: 'compaction',
    runId: `run-compact-${index}`,
    sessionId: 'session-1',
    summary: '摘要',
    coveredEventCount: index,
  };
}

describe('ContextTokenAccumulator', () => {
  it('全量请求始终以本 leg 重锚，即使命中了大量 prompt cache', () => {
    const accumulator = new ContextTokenAccumulator();
    expect(accumulator.apply('gpt-5.6-sol', usage(90_000, 80_000, 1_000), 'full')).toBe(91_000);
    expect(accumulator.apply('gpt-5.6-sol', usage(40_000, 39_000, 500), 'full')).toBe(40_500);
  });

  it('Responses 接力只累计本 leg 净新增', () => {
    const accumulator = new ContextTokenAccumulator();
    expect(accumulator.apply('glm-5.2', usage(60_000, 0, 1_000), 'full')).toBe(61_000);
    expect(accumulator.apply('glm-5.2', usage(50_000, 45_000, 7_000), 'relay')).toBe(73_000);
    expect(accumulator.apply('glm-5.2', usage(50_000, 45_000, 8_000), 'relay')).toBe(86_000);
  });

  it('切换模型与 Responses 降级全量都会重锚', () => {
    const accumulator = new ContextTokenAccumulator();
    accumulator.apply('glm-5.2', usage(60_000, 0, 1_000), 'full');
    expect(accumulator.apply('minimax-m3', usage(20_000, 18_000, 500), 'relay')).toBe(20_500);
    expect(accumulator.apply('minimax-m3', usage(15_000, 14_000, 300), 'fallback_full')).toBe(15_300);
  });
});

describe('calculateCurrentContextTokens', () => {
  it('compaction 后丢弃旧累计，以压缩后的第一个全量请求重新锚定', () => {
    const events = [
      assistant(0, 'glm-5.2', usage(90_000, 0, 1_000), false),
      compaction(1),
      assistant(2, 'glm-5.2', usage(20_000, 10_000, 1_000), false),
      assistant(3, 'glm-5.2', usage(12_000, 10_000, 500), true),
    ];
    expect(calculateCurrentContextTokens(events, 'glm-5.2')).toBe(23_500);
  });

  it('兼容没有 responseChained 字段的存量事件', () => {
    const events = [
      assistant(0, 'glm-5.2', usage(10_000, 0, 500)),
      assistant(1, 'glm-5.2', usage(8_000, 7_000, 300)),
    ];
    expect(calculateCurrentContextTokens(events, 'glm-5.2')).toBe(11_800);
  });
});
