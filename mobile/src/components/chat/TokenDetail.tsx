/**
 * Token 用量胶囊与上下文明细面板（对齐 `web/src/components/TokenUsageDisplay.tsx`）。
 *
 * 信息结构与 Web 一致：上下文占用胶囊 → Hero 卡（百分比 + 进度条 + 自动压缩阈值）
 * → 上下文构成（堆叠彩条 + 可下钻类目树）→ 累计模型用量 → 主 / 子 Agent →
 * 子任务资源 → 记忆文件 / MCP 工具折叠节。
 *
 * 取值优先级、阈值预警与全部文案走 shared `selectTokenUsageView`；
 * `allowDetails`（租户 models.allowContextTokenDetails）为假时胶囊只读、不可展开。
 * 展示零件见 ./TokenDetailParts。
 */
import React, { useMemo } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  formatTokenCount,
  formatUsagePercent,
  selectTokenUsageView,
  tokenCategoryColor,
  type ContextUsageData,
  type MessageItem,
  type TokenUsage,
} from '@agent/shared';
import { useColors, spacing, typography, radius } from '../../theme';
import {
  CategoryTree,
  CollapsibleSection,
  StackedBar,
  TextRow,
  TokenRow,
  barStyles,
  childStatusLabel,
  collectChildAgentResources,
  rowStyles,
  shortSessionId,
  toneBarColor,
  toneColor,
  useStyles,
} from './TokenDetailParts';

interface TokenDetailProps {
  tokenUsage: TokenUsage;
  contextUsage?: ContextUsageData | null;
  messages?: MessageItem[];
  onOpenChildSession?: (sessionId: string) => void;
  sessionId: string;
}

export function TokenDetailTrigger({
  tokenUsage,
  contextUsage,
  allowDetails = true,
  onPress,
}: {
  tokenUsage: TokenUsage;
  contextUsage?: ContextUsageData | null;
  /** 租户模型策略：为假时胶囊只读，不提供展开入口（与 Web allowDetails 一致） */
  allowDetails?: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const view = useMemo(
    () => selectTokenUsageView(tokenUsage, contextUsage),
    [tokenUsage, contextUsage],
  );
  if (!view.visible) return null;
  return (
    <Pressable
      testID="token-usage-pill"
      accessibilityRole={allowDetails ? 'button' : 'text'}
      accessibilityLabel={view.title}
      accessibilityState={{ disabled: !allowDetails }}
      disabled={!allowDetails}
      onPress={onPress}
      hitSlop={8}
      style={[pillStyles.pill, { backgroundColor: colors.muted }]}
    >
      <Text style={[pillStyles.label, { color: toneColor(view.tone, colors) }]}>
        {view.pillLabel}
      </Text>
    </Pressable>
  );
}

const pillStyles = StyleSheet.create({
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs / 2,
    borderRadius: radius.md,
  },
  label: { ...typography.caption },
});

export function TokenDetailOverlay({
  tokenUsage,
  contextUsage,
  messages,
  onOpenChildSession,
  sessionId,
  topOffset,
  onDismiss,
}: TokenDetailProps & { topOffset: number; onDismiss: () => void }) {
  const colors = useColors();
  const styles = useStyles(colors);
  const view = useMemo(
    () => selectTokenUsageView(tokenUsage, contextUsage),
    [tokenUsage, contextUsage],
  );
  const childAgents = collectChildAgentResources(messages);
  const breakdown = view.hasRealtime ? contextUsage?.breakdown : undefined;
  const legacyCategories = view.hasRealtime ? (contextUsage?.categories ?? []) : [];
  const usageTotals = view.hasRealtime ? contextUsage?.usageTotals : undefined;
  const memoryFiles = view.hasRealtime ? (contextUsage?.memoryFiles ?? []) : [];
  const mcpTools = view.hasRealtime ? (contextUsage?.mcpTools ?? []) : [];
  const subagentUsage = tokenUsage.subagentUsage;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      <View style={[styles.card, { top: topOffset }]} testID="token-detail-overlay">
        <ScrollView showsVerticalScrollIndicator={false}>
          {/* Hero 卡：用户点「上下文」最关心的信息放第一屏 */}
          <View style={styles.hero}>
            <View style={styles.heroRow}>
              <Text style={[styles.heroValue, { color: toneColor(view.tone, colors) }]}>
                {view.hasContextWindow
                  ? formatUsagePercent(view.percentage)
                  : formatTokenCount(view.displayTokens)}
              </Text>
              <Text style={styles.hint}>
                {view.hasExactContext ? '当前上下文' : '累计用量 · 口径不可确认'}
                {view.hasContextWindow
                  ? ` ${formatTokenCount(view.displayTokens)} / ${formatTokenCount(view.maxTokens!)}`
                  : ''}
              </Text>
            </View>
            {view.hasContextWindow ? (
              <View style={[barStyles.progressTrack, { backgroundColor: colors.muted }]}>
                <View
                  style={[
                    barStyles.progressFill,
                    {
                      width: `${Math.min(view.percentage * 100, 100)}%`,
                      backgroundColor: toneBarColor(view.tone, colors),
                    },
                  ]}
                />
                {view.hasThreshold ? (
                  <View
                    style={[
                      barStyles.thresholdMark,
                      {
                        left: `${Math.min(view.threshold! * 100, 100)}%`,
                        backgroundColor: colors.foreground,
                      },
                    ]}
                  />
                ) : null}
              </View>
            ) : null}
            {view.autoCompactHint ? <Text style={styles.hint}>{view.autoCompactHint}</Text> : null}
            {view.accountingReason ? <Text style={styles.hint}>{view.accountingReason}</Text> : null}
            <View style={styles.kpiRow}>
              <View style={styles.kpiCell}>
                <Text style={styles.kpiValue}>{formatTokenCount(view.cumulativeTokens)}</Text>
                <Text style={styles.hint}>累计消耗</Text>
              </View>
              <View style={[styles.kpiCell, styles.kpiCellDivided, { borderLeftColor: colors.border }]}>
                <Text style={styles.kpiValue}>
                  {view.cacheHitRatio != null ? formatUsagePercent(view.cacheHitRatio) : '—'}
                </Text>
                <Text style={styles.hint}>缓存命中率</Text>
              </View>
            </View>
          </View>

          {/* 上下文构成：优先用带层级的 breakdown，回退到旧的一维 categories */}
          {breakdown?.categories.length ? (
            <>
              <View style={styles.divider} />
              <Text style={styles.sectionTitle}>上下文构成</Text>
              <Text style={styles.hint}>
                原始估算 {formatTokenCount(breakdown.estimatedTokens)}
                {breakdown.providerContextTokens != null
                  ? ` / 校准总量 ${formatTokenCount(breakdown.providerContextTokens)}`
                  : ''}
              </Text>
              <StackedBar segments={breakdown.categories} colors={colors} />
              <CategoryTree categories={breakdown.categories} colors={colors} styles={styles} />
              <Text style={styles.hint}>总量为 provider 实际值 · 构成按估算占比校准</Text>
            </>
          ) : legacyCategories.length ? (
            <>
              <View style={styles.divider} />
              <Text style={styles.sectionTitle}>上下文构成</Text>
              <StackedBar
                segments={legacyCategories.map((c) => ({
                  key: c.name,
                  name: c.name,
                  tokens: c.tokens,
                }))}
                colors={colors}
              />
              {legacyCategories
                .filter((c) => c.tokens > 0)
                .slice(0, 8)
                .map((c, index) => (
                  <View key={c.name} style={rowStyles.row}>
                    <View style={rowStyles.categoryLabel}>
                      <View
                        style={[
                          rowStyles.swatch,
                          { backgroundColor: tokenCategoryColor(index, colors.chart) },
                        ]}
                      />
                      <Text
                        style={[rowStyles.label, { color: colors.mutedForeground }]}
                        numberOfLines={1}
                      >
                        {c.name}
                        {c.isDeferred ? ' (deferred)' : ''}
                      </Text>
                    </View>
                    <Text style={[rowStyles.value, { color: colors.foreground }]}>
                      {formatTokenCount(c.tokens)}
                    </Text>
                  </View>
                ))}
            </>
          ) : null}

          {/* 累计模型用量 */}
          {usageTotals ? (
            <>
              <View style={styles.divider} />
              <Text style={styles.sectionTitle}>累计模型用量</Text>
              <TokenRow label="输入" value={usageTotals.inputTokens} colors={colors} />
              <TokenRow label="未缓存输入" value={usageTotals.uncachedInputTokens} colors={colors} />
              <TokenRow label="缓存命中" value={usageTotals.cacheReadTokens} colors={colors} />
              <TokenRow label="缓存写入" value={usageTotals.cacheCreationTokens} colors={colors} />
              <TokenRow label="输出" value={usageTotals.outputTokens} colors={colors} />
              {usageTotals.reasoningTokens > 0 ? (
                <TokenRow label="思考" value={usageTotals.reasoningTokens} colors={colors} />
              ) : null}
            </>
          ) : null}

          {/* 主 Agent */}
          <View style={styles.divider} />
          <Text style={styles.sectionTitle}>主 Agent</Text>
          {view.hasExactContext ? (
            <TextRow label="上下文" value={formatTokenCount(view.displayTokens)} colors={colors} />
          ) : null}
          <TextRow
            label="累计消耗"
            value={formatTokenCount(view.parentCumulativeTokens)}
            colors={colors}
          />
          <TokenRow label="累计输入" value={tokenUsage.totalInputTokens} colors={colors} />
          <TokenRow label="累计输出" value={tokenUsage.totalOutputTokens} colors={colors} />
          <TokenRow label="缓存读取" value={tokenUsage.totalCacheReadTokens} colors={colors} />
          <TokenRow label="缓存写入" value={tokenUsage.totalCacheCreationTokens} colors={colors} />
          {tokenUsage.totalCostUsd != null && tokenUsage.totalCostUsd > 0 ? (
            <TextRow
              label={tokenUsage.subagentTotalTokens > 0 ? '主 Agent 等效成本' : '等效成本'}
              value={`$${tokenUsage.totalCostUsd.toFixed(4)}`}
              colors={colors}
            />
          ) : null}

          {/* 子 Agent */}
          {tokenUsage.subagentTotalTokens > 0 ? (
            <>
              <View style={styles.divider} />
              <Text style={styles.sectionTitle}>
                子 Agent
                {subagentUsage
                  ? `（${subagentUsage.childCount} 个 · ${subagentUsage.requestCount} 次调用）`
                  : ''}
              </Text>
              <TextRow
                label="累计消耗"
                value={formatTokenCount(tokenUsage.subagentTotalTokens)}
                colors={colors}
              />
              {subagentUsage ? (
                <>
                  <TokenRow label="输入（含缓存）" value={subagentUsage.inputTokens} colors={colors} />
                  <TokenRow
                    label="非缓存输入"
                    value={subagentUsage.uncachedInputTokens}
                    colors={colors}
                  />
                  <TokenRow label="缓存读取" value={subagentUsage.cacheReadTokens} colors={colors} />
                  <TokenRow
                    label="缓存写入（上报）"
                    value={subagentUsage.cacheCreationTokens}
                    colors={colors}
                  />
                  <TokenRow label="输出" value={subagentUsage.outputTokens} colors={colors} />
                  {subagentUsage.cacheHitRatio != null ? (
                    <TextRow
                      label="缓存命中率"
                      value={formatUsagePercent(subagentUsage.cacheHitRatio)}
                      colors={colors}
                    />
                  ) : null}
                  {subagentUsage.cacheCreationTokens === 0 ? (
                    <Text style={styles.hint}>
                      缓存写入为 provider 上报值；0 不代表一定未创建缓存。
                    </Text>
                  ) : null}
                </>
              ) : null}
              <TextRow
                label="任务总消耗"
                value={formatTokenCount(view.cumulativeTokens)}
                colors={colors}
              />
            </>
          ) : null}

          {/* 子任务资源：下钻到子会话 */}
          {childAgents.length > 0 ? (
            <>
              <View style={styles.divider} />
              <Text style={styles.sectionTitle}>子任务资源</Text>
              {childAgents.map((child) => (
                <Pressable
                  key={child.childSessionId}
                  disabled={!onOpenChildSession}
                  onPress={() => onOpenChildSession?.(child.childSessionId)}
                  style={styles.childResourceRow}
                >
                  <View style={styles.childResourceText}>
                    <Text style={[rowStyles.label, { color: colors.foreground }]} numberOfLines={1}>
                      {child.agentType}
                    </Text>
                    <Text style={styles.hint} numberOfLines={1}>
                      {childStatusLabel(child.status)}
                      {child.model ? ` · ${child.model}` : ''}
                      {typeof child.durationMs === 'number'
                        ? ` · ${(child.durationMs / 1000).toFixed(1)}s`
                        : ''}
                    </Text>
                  </View>
                  <Text style={[rowStyles.value, { color: colors.foreground }]}>
                    {typeof child.totalTokens === 'number'
                      ? formatTokenCount(child.totalTokens)
                      : '—'}
                  </Text>
                </Pressable>
              ))}
            </>
          ) : null}

          {/* 记忆文件 / MCP 工具 */}
          {memoryFiles.length > 0 ? (
            <CollapsibleSection
              title="记忆文件"
              count={memoryFiles.length}
              colors={colors}
              styles={styles}
            >
              {memoryFiles.map((f) => (
                <TextRow
                  key={f.path}
                  label={f.path.split('/').pop() || f.path}
                  value={formatTokenCount(f.tokens)}
                  colors={colors}
                />
              ))}
            </CollapsibleSection>
          ) : null}
          {mcpTools.length > 0 ? (
            <CollapsibleSection
              title="MCP 工具"
              count={mcpTools.length}
              colors={colors}
              styles={styles}
            >
              {[...mcpTools]
                .sort((a, b) => b.tokens - a.tokens)
                .slice(0, 20)
                .map((t) => (
                  <TextRow
                    key={`${t.serverName}:${t.name}`}
                    label={`${t.serverName} / ${t.name}${t.isLoaded === false ? ' (deferred)' : ''}`}
                    value={formatTokenCount(t.tokens)}
                    colors={colors}
                  />
                ))}
              {mcpTools.length > 20 ? (
                <Text style={styles.hint}>仅显示 Token 占用前 20 项</Text>
              ) : null}
            </CollapsibleSection>
          ) : null}

          <View style={styles.divider} />
          <Pressable
            onPress={() => {
              void Clipboard.setStringAsync(shortSessionId(sessionId));
            }}
          >
            <Text style={styles.sessionId} numberOfLines={1}>
              id: {shortSessionId(sessionId)}
            </Text>
          </Pressable>
        </ScrollView>
      </View>
    </View>
  );
}
