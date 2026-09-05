import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useColors, spacing, radius, fontScale, fontWeight } from '../../theme';
import { hapticLight } from '../../lib/haptics';
import type { ButtonIcon } from './Button';

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: ButtonIcon;
  /** 右侧计数（筛选器常见） */
  count?: number;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}

/**
 * 胶囊标签：筛选器与 pill 式分段导航。
 * 选中态用品牌蓝实底（与 Web 抽屉里的 pill tab 一致），未选中为 hairline 描边的中性胶囊。
 */
export function Chip({
  label,
  selected = false,
  onPress,
  icon: Icon,
  count,
  disabled = false,
  style,
  testID,
  accessibilityLabel,
}: ChipProps) {
  const colors = useColors();
  const foreground = selected ? colors.primaryForeground : colors.mutedForeground;

  const handlePress = useCallback(() => {
    hapticLight();
    onPress?.();
  }, [onPress]);

  const body = (
    <>
      {Icon ? <Icon size={ICON_PX} color={foreground} strokeWidth={2} /> : null}
      <Text style={[styles.label, { color: foreground }]} numberOfLines={1}>
        {label}
      </Text>
      {count === undefined ? null : (
        <Text style={[styles.count, { color: foreground }]}>{count}</Text>
      )}
    </>
  );

  const chipStyle: StyleProp<ViewStyle> = [
    styles.chip,
    selected
      ? { backgroundColor: colors.primary, borderColor: colors.primary }
      : { backgroundColor: colors.card, borderColor: colors.border },
    disabled ? styles.disabled : null,
    style,
  ];

  if (!onPress) {
    return (
      <View testID={testID} accessibilityLabel={accessibilityLabel ?? label} style={chipStyle}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={handlePress}
      style={({ pressed }) => [chipStyle, pressed ? styles.pressed : null]}
    >
      {body}
    </Pressable>
  );
}

const ICON_PX = 14;

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    minHeight: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  label: {
    ...fontScale.sm,
    fontWeight: fontWeight.medium,
  },
  count: {
    ...fontScale.xs2,
    fontWeight: fontWeight.semibold,
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.7,
  },
});
