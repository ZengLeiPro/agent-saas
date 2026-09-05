import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useColors } from '../../theme';

export interface SeparatorProps {
  orientation?: 'horizontal' | 'vertical';
  /** 左侧缩进（分组行之间的分隔线通常与文字对齐而非贴边） */
  inset?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Separator({
  orientation = 'horizontal',
  inset = 0,
  style,
  testID,
}: SeparatorProps) {
  const colors = useColors();
  return (
    <View
      testID={testID}
      accessibilityRole="none"
      style={[
        orientation === 'horizontal' ? styles.horizontal : styles.vertical,
        { backgroundColor: colors.border },
        orientation === 'horizontal' ? { marginLeft: inset } : { marginTop: inset },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  horizontal: {
    height: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
  },
  vertical: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
  },
});
