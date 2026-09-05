import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { Loader2 } from 'lucide-react-native';
import { useColors } from '../../theme';
import { hapticLight } from '../../lib/haptics';
import { useSpinStyle } from './motion';
import {
  BUTTON_DISABLED_OPACITY,
  isBareVariant,
  resolveButtonSize,
  resolveButtonVariant,
  type ButtonSize,
  type ButtonVariant,
} from './buttonStyles';

/** 图标以组件形式传入（来自 `src/lib/icons.ts` 的语义注册表或 lucide 原件） */
export type ButtonIcon = React.ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 加载中：图标位替换为旋转的 Loader2，同时禁用点击 */
  loading?: boolean;
  disabled?: boolean;
  /** 左侧图标 */
  icon?: ButtonIcon;
  fullWidth?: boolean;
  /** 默认开启轻触反馈；纯文字链接（link）默认关闭 */
  haptic?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  icon: Icon,
  fullWidth = false,
  haptic,
  style,
  testID,
  accessibilityLabel,
}: ButtonProps) {
  const colors = useColors();
  const tokens = resolveButtonVariant(variant, colors);
  const metrics = resolveButtonSize(size);
  const bare = isBareVariant(variant);
  const inert = disabled || loading;
  const spinStyle = useSpinStyle(loading);
  const wantHaptic = haptic ?? !bare;

  const handlePress = useCallback(() => {
    if (wantHaptic) hapticLight();
    onPress?.();
  }, [wantHaptic, onPress]);

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inert, busy: loading }}
      disabled={inert}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.base,
        bare
          ? styles.bare
          : {
              minHeight: metrics.minHeight,
              paddingHorizontal: metrics.paddingHorizontal,
              borderRadius: metrics.borderRadius,
              backgroundColor: tokens.backgroundColor,
              borderColor: tokens.borderColor,
              borderWidth: tokens.borderWidth,
            },
        { gap: metrics.gap },
        fullWidth ? styles.fullWidth : styles.hug,
        inert ? { opacity: BUTTON_DISABLED_OPACITY } : null,
        pressed && !inert
          ? tokens.pressedBackgroundColor && !bare
            ? { backgroundColor: tokens.pressedBackgroundColor }
            : styles.pressedFade
          : null,
        style,
      ]}
    >
      {loading ? (
        <Animated.View style={spinStyle}>
          <Loader2 size={metrics.iconSize} color={tokens.foreground} strokeWidth={2} />
        </Animated.View>
      ) : Icon ? (
        <View style={styles.iconSlot}>
          <Icon size={metrics.iconSize} color={tokens.foreground} strokeWidth={2} />
        </View>
      ) : null}
      <Text
        numberOfLines={1}
        style={[
          metrics.text,
          { color: tokens.foreground },
          tokens.underline ? styles.underline : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bare: {
    paddingVertical: 2,
  },
  hug: {
    alignSelf: 'flex-start',
  },
  fullWidth: {
    alignSelf: 'stretch',
    width: '100%',
  },
  pressedFade: {
    opacity: 0.7,
  },
  iconSlot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  underline: {
    textDecorationLine: 'underline',
  },
});
