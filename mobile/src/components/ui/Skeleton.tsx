import React from 'react';
import { StyleSheet, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { useColors, radius } from '../../theme';
import { usePulseStyle } from './motion';

export interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  /** 圆形占位（头像） */
  circle?: boolean;
  borderRadius?: number;
  /** 关闭呼吸动画；系统「减少动态效果」开启时也会自动静态 */
  animated?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Skeleton({
  width = '100%',
  height = 12,
  circle = false,
  borderRadius,
  animated = true,
  style,
  testID,
}: SkeletonProps) {
  const colors = useColors();
  const pulseStyle = usePulseStyle(animated);
  const corner = borderRadius ?? (circle ? radius.full : radius.md);

  return (
    <Animated.View
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.base,
        { width, height, borderRadius: corner, backgroundColor: colors.muted },
        circle ? { width: height } : null,
        pulseStyle,
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    overflow: 'hidden',
  },
});
