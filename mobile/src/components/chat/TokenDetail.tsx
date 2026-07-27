import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  formatTokenCount,
  type ContextUsageCategory,
  type ContextUsageData,
  type TokenUsage,
} from '@agent/shared';
import { useColors, spacing, typography, radius, type ThemeColors } from '../../theme';

interface TokenDetailProps {
  tokenUsage: TokenUsage;
  contextUsage?: ContextUsageData | null;
  sessionId: string;
}

export function TokenDetailTrigger({ tokenUsage, contextUsage, onPress }: {
  tokenUsage: TokenUsage;
  contextUsage?: ContextUsageData | null;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable onPress={onPress} hitSlop={8}>
      <Text style={{ fontSize: 12, color: colors.mutedForeground }}>
        {formatTokenCount(contextUsage?.totalTokens ?? tokenUsage.contextTokens)}
      </Text>
    </Pressable>
  );
}

export function TokenDetailOverlay({ tokenUsage, contextUsage, sessionId, topOffset, onDismiss }: TokenDetailProps & {
  topOffset: number;
  onDismiss: () => void;
}) {
  const colors = useColors();
  const styles = useStyles(colors);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      <View style={[styles.card, { top: topOffset }]}>
        <ScrollView showsVerticalScrollIndicator={false}>
          <Text style={styles.title}>上下文详情</Text>
          <TokenRow label="当前上下文" value={contextUsage?.totalTokens ?? tokenUsage.contextTokens} colors={colors} />
          {contextUsage?.maxTokens ? (
            <Text style={styles.hint}>
              {formatTokenCount(contextUsage.totalTokens)} / {formatTokenCount(contextUsage.maxTokens)}
              {contextUsage.percentage != null ? ` · ${(contextUsage.percentage * 100).toFixed(1)}%` : ''}
            </Text>
          ) : null}
          {contextUsage?.breakdown?.categories.length ? (
            <>
              <View style={styles.divider} />
              <Text style={styles.sectionTitle}>构成（估算）</Text>
              <CategoryList categories={contextUsage.breakdown.categories} colors={colors} />
              <Text style={styles.hint}>总量为 provider 实际值，分类为平台估算</Text>
            </>
          ) : null}
          <View style={styles.divider} />
          <Text style={styles.sectionTitle}>累计模型用量</Text>
          <TokenRow label="输入" value={contextUsage?.usageTotals?.inputTokens ?? tokenUsage.totalInputTokens} colors={colors} />
          <TokenRow label="输出" value={contextUsage?.usageTotals?.outputTokens ?? tokenUsage.totalOutputTokens} colors={colors} />
          <TokenRow label="缓存读取" value={contextUsage?.usageTotals?.cacheReadTokens ?? tokenUsage.totalCacheReadTokens} colors={colors} />
          <TokenRow label="缓存写入" value={contextUsage?.usageTotals?.cacheCreationTokens ?? tokenUsage.totalCacheCreationTokens} colors={colors} />
          {(contextUsage?.usageTotals?.reasoningTokens ?? 0) > 0 && (
            <TokenRow label="思考" value={contextUsage!.usageTotals!.reasoningTokens} colors={colors} />
          )}
          {tokenUsage.subagentTotalTokens > 0 && (
            <TokenRow label="子 Agent" value={tokenUsage.subagentTotalTokens} colors={colors} />
          )}
          {tokenUsage.totalCostUsd != null && tokenUsage.totalCostUsd > 0 && (
            <View style={rowStyles.row}>
              <Text style={[rowStyles.label, { color: colors.mutedForeground }]}>等效成本</Text>
              <Text style={[rowStyles.value, { color: colors.foreground }]}>${tokenUsage.totalCostUsd.toFixed(4)}</Text>
            </View>
          )}
          <View style={styles.divider} />
          <Pressable onPress={() => {
            const shortId = sessionId.split('-').slice(0, 2).join('-');
            Clipboard.setStringAsync(shortId);
          }}>
            <Text style={styles.sessionId} numberOfLines={1}>id: {sessionId.split('-').slice(0, 2).join('-')}</Text>
          </Pressable>
        </ScrollView>
      </View>
    </View>
  );
}

function CategoryList({ categories, colors, depth = 0 }: {
  categories: ContextUsageCategory[];
  colors: ThemeColors;
  depth?: number;
}) {
  return (
    <View style={depth > 0 ? { marginLeft: spacing.sm } : undefined}>
      {categories.filter((item) => item.tokens > 0).map((item) => (
        <View key={item.key}>
          <View style={rowStyles.row}>
            <View style={rowStyles.categoryLabel}>
              <View style={[rowStyles.swatch, { backgroundColor: item.color }]} />
              <Text style={[rowStyles.label, { color: colors.mutedForeground }]} numberOfLines={1}>
                {item.name}{item.isDeferred ? ' (deferred)' : ''}
              </Text>
              <Text style={[rowStyles.badge, { color: colors.mutedForeground }]}>
                {item.accuracy === 'derived' ? '差额' : '估算'}
              </Text>
            </View>
            <Text style={[rowStyles.value, { color: colors.foreground }]}>{formatTokenCount(item.tokens)}</Text>
          </View>
          {item.children?.length ? <CategoryList categories={item.children} colors={colors} depth={depth + 1} /> : null}
        </View>
      ))}
    </View>
  );
}

function TokenRow({ label, value, colors }: { label: string; value: number; colors: ThemeColors }) {
  return (
    <View style={rowStyles.row}>
      <Text style={[rowStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[rowStyles.value, { color: colors.foreground }]}>{value.toLocaleString()}</Text>
    </View>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3,
  },
  label: {
    ...typography.caption,
  },
  value: {
    ...typography.caption,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  categoryLabel: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  swatch: {
    width: 7,
    height: 7,
    borderRadius: 2,
  },
  badge: {
    fontSize: 9,
  },
});

function useStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: {
      position: 'absolute',
      right: spacing.md,
      width: 320,
      maxHeight: 560,
      backgroundColor: colors.card,
      borderRadius: radius.lg,
      padding: spacing.md,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 12,
      elevation: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    title: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.foreground,
      marginBottom: spacing.sm,
    },
    sectionTitle: {
      ...typography.caption,
      fontWeight: '600',
      color: colors.foreground,
      marginBottom: 2,
    },
    hint: {
      fontSize: 10,
      lineHeight: 14,
      color: colors.mutedForeground,
    },
    divider: {
      height: 1,
      backgroundColor: colors.border,
      marginVertical: 6,
    },
    sessionId: {
      ...typography.caption,
      color: colors.mutedForeground,
      paddingVertical: 2,
    },
  });
}
