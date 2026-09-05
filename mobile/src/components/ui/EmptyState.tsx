import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useColors, spacing, fontScale, fontWeight } from '../../theme';
import { Button, type ButtonIcon } from './Button';

export interface EmptyStateProps {
  /** 语义图标（取自 `src/lib/icons.ts`） */
  icon?: ButtonIcon;
  title: string;
  description?: string;
  /** 可选主行动按钮 */
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  style,
  testID,
}: EmptyStateProps) {
  const colors = useColors();
  return (
    <View testID={testID} style={[styles.container, style]}>
      {Icon ? (
        <View style={[styles.iconWrap, { backgroundColor: colors.muted }]}>
          <Icon size={ICON_PX} color={colors.mutedForeground} strokeWidth={2} />
        </View>
      ) : null}
      <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
      {description ? (
        <Text style={[styles.description, { color: colors.mutedForeground }]}>{description}</Text>
      ) : null}
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} variant="primary" size="md" />
      ) : null}
    </View>
  );
}

/** 空态图标比页面标题图标再大一档，撑得住整屏留白 */
const ICON_PX = 28;

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing['2xl'],
    paddingVertical: spacing['3xl'],
    gap: spacing.md,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    ...fontScale.base,
    fontWeight: fontWeight.semibold,
    textAlign: 'center',
  },
  description: {
    ...fontScale.sm,
    textAlign: 'center',
  },
});
