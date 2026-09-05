/**
 * 空态建议卡 —— 对齐 Web `EmptyChatRecommendCards` / `EmptySessionScenarios` /
 * `ExpertWelcome` 共用的那张卡：标题 + 动作文案 + 右侧 chevron。
 *
 * Web 是 `min-h-[56px] rounded-2xl border bg-card/70` 的按钮；这里用同样的
 * 最小高度、圆角与描边，颜色全部走 theme token。
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import type { ScenarioActionTone } from '@agent/shared';
import { useColors, radius, spacing, typography } from '../../theme';

/** 卡片最小高度（pt），对齐 Web `min-h-[56px]` */
const CARD_MIN_HEIGHT = 56;
const LEADING_SIZE = 32;
const PRESSED_OPACITY = 0.7;

export interface SuggestionCardProps {
  title: string;
  /** 右下角动作文案：直接试 / 预填任务 */
  action: string;
  tone: ScenarioActionTone;
  /** 左侧图标（企业专家起手任务用），缺省时不占位 */
  icon?: LucideIcon;
  onPress: () => void;
  testID?: string;
}

export function SuggestionCard({
  title,
  action,
  tone,
  icon: Icon,
  onPress,
  testID,
}: SuggestionCardProps) {
  const colors = useColors();

  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          minHeight: CARD_MIN_HEIGHT,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          borderRadius: radius['2xl'],
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          backgroundColor: colors.card,
        },
        pressed: { opacity: PRESSED_OPACITY, borderColor: colors.brand[200] },
        leading: {
          width: LEADING_SIZE,
          height: LEADING_SIZE,
          borderRadius: radius.xl,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.brand[50],
        },
        body: { flex: 1, minWidth: 0 },
        title: { ...typography.bodySmall, color: colors.foreground, fontWeight: '600' },
        action: {
          ...typography.meta,
          fontWeight: '500',
          marginTop: 2,
          color: tone === 'success' ? colors.successFamily.ink : colors.mutedForeground,
        },
      }),
    [colors, tone],
  );

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${title}，${action}`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      {Icon ? (
        <View style={styles.leading}>
          <Icon size={16} color={colors.brand[600]} strokeWidth={2} />
        </View>
      ) : null}
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        <Text style={styles.action}>{action}</Text>
      </View>
      <ChevronRight size={16} color={colors.mutedForeground} strokeWidth={2} />
    </Pressable>
  );
}
