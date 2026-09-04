/**
 * 会话页顶栏（对齐 `web/src/layouts/MobileLayout.tsx` §1.2）。
 *
 * 三态：
 *   - 子任务面板打开 → 标题「子任务完整过程 · {title}」，左键关闭面板；
 *   - 默认           → 标题为会话名 + Agent 名，点 Agent 行打开目标选择，
 *                      点顶栏空白处消息列表滚回顶部；
 *   （文件预览在移动端是独立路由 `/chat/markdown-preview`，自带返回，不占顶栏态。）
 *
 * 右侧：Token 用量胶囊 + 积分徽标（两张用量卡互斥展开）+ TTS 自动播放开关。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronDown, Volume2, VolumeX } from 'lucide-react-native';
import type { ContextUsageData, TokenUsage } from '@agent/shared';
import { useColors, spacing, fontScale, fontWeight } from '../../theme';
import { ICON_SIZE, ICON_STROKE } from '../../lib/icons';
import { TokenDetailTrigger } from './TokenDetail';
import { BillingMiniBadgeTrigger, type BillingBadgeData } from './BillingMiniBadge';

/** 顶栏左右两侧给标题预留的宽度，避免长标题把返回键/胶囊挤出屏幕。 */
export const HEADER_SIDE_RESERVE = 60;

export interface ChatHeaderTitleProps {
  /** 子任务面板打开时的标题；为空表示默认态。 */
  transcriptTitle?: string | null;
  sessionTitle: string;
  agentLabel: string;
  screenWidth: number;
  /** 点 Agent 行：打开 Agent 目标选择。 */
  onPressAgent: () => void;
  /** 点顶栏空白处：消息列表滚回顶部。 */
  onPressBlank: () => void;
  agentPickerDisabled?: boolean;
}

export function ChatHeaderTitle({
  transcriptTitle,
  sessionTitle,
  agentLabel,
  screenWidth,
  onPressAgent,
  onPressBlank,
  agentPickerDisabled,
}: ChatHeaderTitleProps) {
  const colors = useColors();
  const width = Math.max(0, screenWidth - HEADER_SIDE_RESERVE * 2);

  if (transcriptTitle) {
    return (
      <View style={[styles.row, { width }]}>
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
          子任务完整过程 · {transcriptTitle}
        </Text>
      </View>
    );
  }

  return (
    <Pressable
      style={[styles.row, { width }]}
      accessibilityLabel="回到消息顶部"
      onPress={onPressBlank}
    >
      <Pressable
        testID="agent-target-picker"
        accessibilityRole="button"
        accessibilityState={{ disabled: !!agentPickerDisabled }}
        accessibilityLabel="Agent 选择器"
        disabled={agentPickerDisabled}
        onPress={onPressAgent}
        style={styles.inner}
      >
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
          {sessionTitle}
        </Text>
        <View style={styles.agentRow}>
          <Text style={[styles.agentLabel, { color: colors.mutedForeground }]} numberOfLines={1}>
            {agentLabel}
          </Text>
          <ChevronDown
            size={ICON_SIZE.inline}
            color={colors.mutedForeground}
            strokeWidth={ICON_STROKE.default}
          />
        </View>
      </Pressable>
    </Pressable>
  );
}

export interface ChatHeaderRightProps {
  tokenUsage?: TokenUsage | null;
  contextUsage?: ContextUsageData | null;
  /** 租户策略 `models.showContextTokens`，为假时整个胶囊不渲染。 */
  showContextTokens: boolean;
  allowContextTokenDetails: boolean;
  onToggleTokenCard: () => void;
  billing: BillingBadgeData;
  onToggleBillingCard: () => void;
  ttsAvailable: boolean;
  ttsAutoPlay: boolean;
  onToggleTtsAutoPlay: () => void;
}

export function ChatHeaderRight({
  tokenUsage,
  contextUsage,
  showContextTokens,
  allowContextTokenDetails,
  onToggleTokenCard,
  billing,
  onToggleBillingCard,
  ttsAvailable,
  ttsAutoPlay,
  onToggleTtsAutoPlay,
}: ChatHeaderRightProps) {
  const colors = useColors();
  return (
    <View style={styles.rightRow}>
      {showContextTokens && tokenUsage ? (
        <TokenDetailTrigger
          tokenUsage={tokenUsage}
          contextUsage={contextUsage}
          allowDetails={allowContextTokenDetails}
          onPress={onToggleTokenCard}
        />
      ) : null}
      <BillingMiniBadgeTrigger data={billing} onPress={onToggleBillingCard} />
      {ttsAvailable ? (
        <Pressable
          testID="tts-autoplay-toggle"
          accessibilityRole="button"
          accessibilityState={{ selected: ttsAutoPlay }}
          accessibilityLabel={ttsAutoPlay ? '语音自动播放已开启' : '语音自动播放已关闭'}
          hitSlop={8}
          onPress={onToggleTtsAutoPlay}
        >
          {ttsAutoPlay ? (
            <Volume2
              size={ICON_SIZE.feature}
              color={colors.primary}
              strokeWidth={ICON_STROKE.default}
            />
          ) : (
            <VolumeX
              size={ICON_SIZE.feature}
              color={colors.mutedForeground}
              strokeWidth={ICON_STROKE.default}
            />
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  inner: {
    flexShrink: 1,
    minWidth: 0,
    alignItems: 'center',
    overflow: 'hidden',
  },
  title: {
    ...fontScale.sm,
    fontWeight: fontWeight.semibold,
  },
  agentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs / 2,
  },
  agentLabel: {
    ...fontScale.xs2,
  },
  rightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
});
