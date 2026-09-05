import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useColors } from '../../theme';
import {
  resolveBadgeSize,
  resolveBadgeVariant,
  type BadgeSize,
  type BadgeVariant,
} from './badgeStyles';

export interface BadgeProps {
  label: string;
  variant?: BadgeVariant;
  size?: BadgeSize;
  /** 徽章左侧的小图标（可选） */
  leading?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Badge({
  label,
  variant = 'default',
  size = 'md',
  leading,
  style,
  testID,
}: BadgeProps) {
  const colors = useColors();
  const tokens = resolveBadgeVariant(variant, colors);
  const metrics = resolveBadgeSize(size);

  return (
    <View
      testID={testID}
      accessibilityLabel={label}
      style={[
        styles.base,
        {
          paddingHorizontal: metrics.paddingHorizontal,
          paddingVertical: metrics.paddingVertical,
          borderRadius: metrics.borderRadius,
          gap: metrics.gap,
          backgroundColor: tokens.backgroundColor,
          borderColor: tokens.borderColor,
          borderWidth: tokens.borderWidth,
        },
        style,
      ]}
    >
      {leading}
      <Text numberOfLines={1} style={[metrics.text, { color: tokens.foreground }]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
});
