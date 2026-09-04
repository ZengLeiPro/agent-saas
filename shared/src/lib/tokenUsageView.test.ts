import { describe, expect, it } from 'vitest';

import {
  contextAccuracyLabel,
  formatUsagePercent,
  selectTokenUsageView,
  tokenCategoryColor,
} from './tokenUsageView';
import type { ContextUsageData, TokenUsage } from '../types/session';

const usage = (patch: Partial<TokenUsage> = {}): TokenUsage => ({
  contextTokens: 0,
  totalInputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  totalOutputTokens: 0,
  subagentTotalTokens: 0,
  ...patch,
});

const context = (patch: Partial<ContextUsageData> = {}): ContextUsageData => ({
  totalTokens: 0,
  categories: [],
  memoryFiles: [],
  mcpTools: [],
  ...patch,
});

describe('selectTokenUsageView 取值优先级', () => {
  it('两侧都为空时不可见', () => {
    const view = selectTokenUsageView(null, null);
    expect(view.visible).toBe(false);
    expect(view.displayTokens).toBe(0);
  });

  it('实时 contextUsage 优先于 tokenUsage', () => {
    const view = selectTokenUsageView(
      usage({ contextTokens: 500, totalInputTokens: 900 }),
      context({ totalTokens: 1200 }),
    );
    expect(view.hasRealtime).toBe(true);
    expect(view.hasExactContext).toBe(true);
    expect(view.displayTokens).toBe(1200);
    expect(view.pillLabel).toBe('1.2k');
  });

  it('无实时事件且 accounting.exact 时用 provider usage 当当前上下文', () => {
    const view = selectTokenUsageView(
      usage({
        contextTokens: 2000,
        totalInputTokens: 3000,
        contextAccounting: {
          exact: true,
          kind: 'exact_current',
          source: 'provider_usage',
          label: '精确',
          reason: '全量重发',
        },
      }),
      null,
    );
    expect(view.hasExactContext).toBe(true);
    expect(view.displayTokens).toBe(2000);
    expect(view.title).toContain('provider usage');
    expect(view.accountingReason).toBe('全量重发');
  });

  it('口径不可确认时退化成累计用量并给出解释', () => {
    const view = selectTokenUsageView(
      usage({
        contextTokens: 900,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        subagentTotalTokens: 20,
      }),
      null,
    );
    expect(view.hasExactContext).toBe(false);
    expect(view.displayTokens).toBe(170);
    expect(view.pillLabel).toBe('累计 170');
    expect(view.title).toContain('显示累计用量');
    expect(view.accountingReason).toBe('当前上下文口径不可确认，以上展示累计用量。');
  });

  it('totalTokens 存在时直接作为累计消耗', () => {
    const view = selectTokenUsageView(
      usage({ totalTokens: 5000, totalInputTokens: 1, subagentTotalTokens: 1200 }),
      null,
    );
    expect(view.cumulativeTokens).toBe(5000);
    expect(view.parentCumulativeTokens).toBe(3800);
  });
});

describe('selectTokenUsageView 阈值预警', () => {
  const withWindow = (percentage: number, threshold?: number) =>
    selectTokenUsageView(
      usage({ totalTokens: 100 }),
      context({
        totalTokens: 80_000,
        maxTokens: 200_000,
        percentage,
        ...(threshold != null
          ? { autoCompactThreshold: threshold, isAutoCompactEnabled: true }
          : {}),
      }),
    );

  it('无阈值时保持中性色，不做预警', () => {
    const view = withWindow(0.99);
    expect(view.hasThreshold).toBe(false);
    expect(view.tone).toBe('normal');
    expect(view.autoCompactHint).toBeNull();
  });

  it('达到阈值 80% 转 warning，达到阈值转 danger', () => {
    expect(withWindow(0.5, 0.8).tone).toBe('normal');
    expect(withWindow(0.65, 0.8).tone).toBe('warning');
    expect(withWindow(0.85, 0.8).tone).toBe('danger');
  });

  it('阈值提示区分「即将压缩」与「还剩多少」', () => {
    expect(withWindow(0.85, 0.8).autoCompactHint).toContain('已达阈值');
    expect(withWindow(0.5, 0.8).autoCompactHint).toContain('距压缩还剩');
    expect(withWindow(0.5, 0.8).thresholdTokens).toBe(160_000);
  });

  it('有窗口时胶囊带整数百分比，title 带一位小数', () => {
    const view = withWindow(0.456);
    expect(view.pillLabel).toBe('80.0k · 46%');
    expect(view.title).toBe('上下文占用：80.0k / 200.0k (45.6%)');
  });

  it('maxTokens 为 0 视为无窗口', () => {
    const view = selectTokenUsageView(
      usage(),
      context({ totalTokens: 100, maxTokens: 0, percentage: 0.5 }),
    );
    expect(view.hasContextWindow).toBe(false);
    expect(view.pillLabel).toBe('100');
  });
});

describe('缓存命中率取值', () => {
  it('有实时事件时优先取实时值', () => {
    const view = selectTokenUsageView(
      usage({ cacheHitRatio: 0.1 }),
      context({ totalTokens: 10, cacheHitRatio: 0.9 }),
    );
    expect(view.cacheHitRatio).toBe(0.9);
  });

  it('实时值为 null 时回落到累计值', () => {
    const view = selectTokenUsageView(
      usage({ cacheHitRatio: 0.25 }),
      context({ totalTokens: 10, cacheHitRatio: null }),
    );
    expect(view.cacheHitRatio).toBe(0.25);
  });

  it('两侧都没有时为 null', () => {
    expect(selectTokenUsageView(usage({ totalTokens: 5 }), null).cacheHitRatio).toBeNull();
  });
});

describe('展示辅助', () => {
  it('formatUsagePercent 保留一位小数', () => {
    expect(formatUsagePercent(0.1234)).toBe('12.3%');
  });

  it('tokenCategoryColor 在调色板内轮转', () => {
    const palette = ['a', 'b', 'c'];
    expect(tokenCategoryColor(0, palette)).toBe('a');
    expect(tokenCategoryColor(4, palette)).toBe('b');
    expect(tokenCategoryColor(-1, palette)).toBe('c');
    expect(tokenCategoryColor(0, [])).toBe('');
  });

  it('口径标签三态', () => {
    expect(contextAccuracyLabel('provider')).toBe('实际');
    expect(contextAccuracyLabel('derived')).toBe('差额');
    expect(contextAccuracyLabel('estimated')).toBe('校准估算');
  });
});
