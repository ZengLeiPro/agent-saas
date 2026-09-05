import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { useColors, radius } from '../../theme';
import { StatusIcons, ICON_SIZE, ICON_STROKE } from '../../lib/icons';
import { Badge } from './Badge';
import { resolveBadgeSize, type BadgeSize } from './badgeStyles';
import { resolveStatusTone, type RunStatus } from './statusStyles';
import { useSpinStyle } from './motion';

export interface StatusBadgeProps {
  status: RunStatus;
  /** 覆盖默认中文文案 */
  label?: string;
  size?: BadgeSize;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** 状态图标（running 持续旋转），可单独用于行内 */
export function StatusIcon({ status, size }: { status: RunStatus; size?: number }) {
  const colors = useColors();
  const tone = resolveStatusTone(status, colors);
  const spinStyle = useSpinStyle(tone.spinning);
  const Icon = StatusIcons[status];
  const iconSize = size ?? ICON_SIZE.inline;
  const glyph = <Icon size={iconSize} color={tone.ink} strokeWidth={ICON_STROKE.default} />;

  if (!tone.spinning) return glyph;
  return <Animated.View style={spinStyle}>{glyph}</Animated.View>;
}

export function StatusBadge({ status, label, size = 'sm', style, testID }: StatusBadgeProps) {
  const colors = useColors();
  const tone = resolveStatusTone(status, colors);
  const metrics = resolveBadgeSize(size);

  return (
    <Badge
      testID={testID}
      variant={tone.badgeVariant}
      size={size}
      label={label ?? tone.label}
      leading={<StatusIcon status={status} size={metrics.iconSize} />}
      style={style}
    />
  );
}

export interface StatusDotProps {
  status: RunStatus;
  /** 圆点直径 */
  size?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** 纯色圆点：列表行里不占宽度地表达状态 */
export function StatusDot({ status, size = 8, style, testID }: StatusDotProps) {
  const colors = useColors();
  const tone = resolveStatusTone(status, colors);
  return (
    <View
      testID={testID}
      accessibilityLabel={tone.label}
      style={[
        styles.dot,
        { width: size, height: size, borderRadius: radius.full, backgroundColor: tone.tint },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    flexShrink: 0,
  },
});
