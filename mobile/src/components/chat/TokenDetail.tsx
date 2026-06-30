import React from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { formatTokenCount, type TokenUsage } from '@agent/shared';
import { useColors, spacing, typography, radius, type ThemeColors } from '../../theme';

interface TokenDetailProps {
  tokenUsage: TokenUsage;
  sessionId: string;
}

export function TokenDetailTrigger({ tokenUsage, onPress }: {
  tokenUsage: TokenUsage;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable onPress={onPress} hitSlop={8}>
      <Text style={{ fontSize: 12, color: colors.mutedForeground }}>
        {formatTokenCount(tokenUsage.contextTokens)}
      </Text>
    </Pressable>
  );
}

export function TokenDetailOverlay({ tokenUsage, sessionId, topOffset, onDismiss }: TokenDetailProps & {
  topOffset: number;
  onDismiss: () => void;
}) {
  const colors = useColors();
  const styles = useStyles(colors);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      <View style={[styles.card, { top: topOffset }]}>
        <Text style={styles.title}>Token 消耗</Text>
        <TokenRow label="上下文" value={tokenUsage.contextTokens} colors={colors} />
        <View style={styles.divider} />
        <TokenRow label="输入" value={tokenUsage.totalInputTokens} colors={colors} />
        <TokenRow label="输出" value={tokenUsage.totalOutputTokens} colors={colors} />
        <TokenRow label="缓存读取" value={tokenUsage.totalCacheReadTokens} colors={colors} />
        <TokenRow label="缓存写入" value={tokenUsage.totalCacheCreationTokens} colors={colors} />
        {tokenUsage.subagentTotalTokens > 0 && (
          <>
            <View style={styles.divider} />
            <TokenRow label="子 Agent" value={tokenUsage.subagentTotalTokens} colors={colors} />
          </>
        )}
        {tokenUsage.totalCostUsd != null && tokenUsage.totalCostUsd > 0 && (
          <>
            <View style={styles.divider} />
            <View style={rowStyles.row}>
              <Text style={[rowStyles.label, { color: colors.mutedForeground }]}>等效成本</Text>
              <Text style={[rowStyles.value, { color: colors.foreground }]}>${tokenUsage.totalCostUsd.toFixed(4)}</Text>
            </View>
          </>
        )}
        <View style={styles.divider} />
        <Pressable onPress={() => {
          const shortId = sessionId.split('-').slice(0, 2).join('-');
          Clipboard.setStringAsync(shortId);
        }}>
          <Text style={styles.sessionId} numberOfLines={1}>id: {sessionId.split('-').slice(0, 2).join('-')}</Text>
        </Pressable>
      </View>
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
});

function useStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: {
      position: 'absolute',
      right: spacing.md,
      width: 200,
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
