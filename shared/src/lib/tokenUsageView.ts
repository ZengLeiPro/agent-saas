/**
 * Token 用量胶囊 / 明细面板的展示模型（两端同源）。
 *
 * 由 `web/src/components/TokenUsageDisplay.tsx` 组件里的派生逻辑下沉而来：
 * 「当前上下文 vs 累计消耗」的取值优先级、阈值预警口径、胶囊与 tooltip 文案
 * 都在这里定型，web / mobile 只负责把结果画出来。
 *
 * 取值优先级（不可随手改，涉及计费口径解释）：
 * 1. 实时 contextUsage（SDK getContextUsage）优先；
 * 2. 没有实时事件时，只有服务端明确标记 contextAccounting.exact=true
 *    才把 provider usage 当「当前上下文」；
 * 3. 其余一律退化成「累计用量」，并在文案里标明口径不可确认。
 */
import { formatTokenCount } from '../types/session';
import type { ContextUsageData, TokenUsage } from '../types/session';

export type TokenUsageTone = 'normal' | 'warning' | 'danger';

export interface TokenUsageView {
  /** displayTokens 为 0 时整个入口不渲染（与 web 的 early return 对齐） */
  visible: boolean;
  /** 胶囊与 Hero 卡展示的主数值 */
  displayTokens: number;
  /** 任务累计消耗（只增不减，关联成本） */
  cumulativeTokens: number;
  /** 主 Agent 累计（累计消耗 - 子 Agent） */
  parentCumulativeTokens: number;
  hasRealtime: boolean;
  /** true = displayTokens 是「当前上下文」；false = 退化成累计用量 */
  hasExactContext: boolean;
  /** true = 已知上下文窗口，可画百分比与进度条 */
  hasContextWindow: boolean;
  maxTokens: number | null;
  percentage: number;
  threshold: number | null;
  thresholdTokens: number;
  hasThreshold: boolean;
  nearThreshold: boolean;
  overThreshold: boolean;
  tone: TokenUsageTone;
  /** 胶囊文案：`12.3k` / `12.3k · 45%` / `累计 12.3k` */
  pillLabel: string;
  /** 长按 / tooltip 的完整口径说明 */
  title: string;
  cacheHitRatio: number | null;
  /** 口径不可确认 / provider usage 兜底时的解释文案 */
  accountingReason: string | null;
  /** 自动压缩阈值提示；未开启自动压缩或无阈值时为 null */
  autoCompactHint: string | null;
}

/** 比例 → 百分比文案（保留一位小数） */
export function formatUsagePercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * 分类色：一律取主题的 chart 调色板按顺序轮转，
 * 不消费服务端下发的十六进制色值（移动端禁止字面量色值）。
 */
export function tokenCategoryColor(index: number, palette: readonly string[]): string {
  if (!palette.length) return '';
  return palette[((index % palette.length) + palette.length) % palette.length];
}

export function selectTokenUsageView(
  tokenUsage: TokenUsage | null | undefined,
  contextUsage?: ContextUsageData | null,
): TokenUsageView {
  const accounting = tokenUsage?.contextAccounting;
  const cumulativeTokens = tokenUsage
    ? (tokenUsage.totalTokens ??
      tokenUsage.totalInputTokens + tokenUsage.totalOutputTokens + tokenUsage.subagentTotalTokens)
    : 0;

  const hasRealtime = !!contextUsage && contextUsage.totalTokens > 0;
  const hasContextWindow =
    hasRealtime &&
    typeof contextUsage!.maxTokens === 'number' &&
    contextUsage!.maxTokens > 0 &&
    typeof contextUsage!.percentage === 'number';
  const hasExactFallback =
    !hasRealtime && accounting?.exact === true && (tokenUsage?.contextTokens ?? 0) > 0;
  const hasExactContext = hasRealtime || hasExactFallback;
  const displayTokens = hasRealtime
    ? contextUsage!.totalTokens
    : hasExactFallback
      ? tokenUsage!.contextTokens
      : cumulativeTokens;

  const percentage = hasContextWindow ? contextUsage!.percentage! : 0;
  const threshold = contextUsage?.autoCompactThreshold ?? null;
  // threshold 未定义时不做预警（不能拿 1 当默认，否则预警永远不触发）
  const hasThreshold = hasContextWindow && threshold != null;
  const nearThreshold = hasThreshold && percentage >= threshold! * 0.8;
  const overThreshold = hasThreshold && percentage >= threshold!;
  const maxTokens = hasContextWindow ? contextUsage!.maxTokens! : null;
  const thresholdTokens = hasThreshold ? Math.floor(maxTokens! * threshold!) : 0;

  const realtimeCacheRatio =
    typeof contextUsage?.cacheHitRatio === 'number' ? contextUsage.cacheHitRatio : undefined;
  const tokenCacheRatio =
    typeof tokenUsage?.cacheHitRatio === 'number' ? tokenUsage.cacheHitRatio : undefined;
  const cacheHitRatio =
    hasRealtime && realtimeCacheRatio !== undefined ? realtimeCacheRatio : tokenCacheRatio;

  const pillLabel =
    (hasExactContext
      ? formatTokenCount(displayTokens)
      : `累计 ${formatTokenCount(displayTokens)}`) +
    (hasContextWindow ? ` · ${(percentage * 100).toFixed(0)}%` : '');

  const title =
    hasRealtime && hasContextWindow
      ? `上下文占用：${formatTokenCount(displayTokens)} / ${formatTokenCount(maxTokens!)} (${formatUsagePercent(percentage)})`
      : hasRealtime
        ? `当前上下文：${formatTokenCount(displayTokens)}`
        : hasExactFallback
          ? `当前上下文：${formatTokenCount(displayTokens)}（provider usage）`
          : `${accounting?.label ?? '上下文不可确认'}：显示累计用量`;

  const autoCompactHint =
    hasThreshold && contextUsage!.isAutoCompactEnabled
      ? `自动压缩阈值 ${formatTokenCount(thresholdTokens)}（${(threshold! * 100).toFixed(0)}%）` +
        (overThreshold
          ? ' · 已达阈值，即将自动压缩'
          : ` · 距压缩还剩 ${formatTokenCount(Math.max(0, thresholdTokens - displayTokens))}`)
      : null;

  return {
    visible: displayTokens > 0,
    displayTokens,
    cumulativeTokens,
    parentCumulativeTokens: tokenUsage
      ? Math.max(0, cumulativeTokens - tokenUsage.subagentTotalTokens)
      : 0,
    hasRealtime,
    hasExactContext,
    hasContextWindow,
    maxTokens,
    percentage,
    threshold,
    thresholdTokens,
    hasThreshold,
    nearThreshold,
    overThreshold,
    tone: overThreshold ? 'danger' : nearThreshold ? 'warning' : 'normal',
    pillLabel,
    title,
    cacheHitRatio: cacheHitRatio ?? null,
    accountingReason: hasExactContext
      ? hasExactFallback
        ? (accounting?.reason ?? null)
        : null
      : (accounting?.reason ?? '当前上下文口径不可确认，以上展示累计用量。'),
    autoCompactHint,
  };
}

/** 分类构成的口径标签（provider 实际 / 差额倒推 / 校准估算） */
export function contextAccuracyLabel(accuracy: 'provider' | 'estimated' | 'derived'): string {
  if (accuracy === 'provider') return '实际';
  if (accuracy === 'derived') return '差额';
  return '校准估算';
}
