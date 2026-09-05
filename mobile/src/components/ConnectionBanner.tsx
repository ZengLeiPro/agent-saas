import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import ReAnimated from 'react-native-reanimated';
import { Loader2 } from 'lucide-react-native';
import type { ConnectionState } from '@agent/shared';
import { spacing, fontScale, fontWeight, useThemedStyles } from '../theme';
import { ICON_SIZE, ICON_STROKE } from '../lib/icons';
import { useSpinStyle } from './ui/motion';

interface ConnectionBannerProps {
  connectionState: ConnectionState;
  isOnline: boolean;
}

const BANNER_HEIGHT = 32;
/** 重连中：与 Web `bg-warning/80` 对齐——RN 无法对 hsl 字符串取 alpha，改用整体透明度 */
const RECONNECTING_OPACITY = 0.8;

/**
 * 顶部连接状态横幅，与 Web `DesktopLayout` / `MobileLayout` 的横幅语义一致：
 *   离线   → warning 实底 +「网络未连接」（Web 自 PR #484 起同为中文「网络未连接」）
 *   重连中 → warning 80% + 旋转 Loader2 +「重新连接中...」
 *   已断开 → danger 实底（移动端独有：WS 断开比单纯没网更需要引起注意，Web 无此态）
 *
 * 注：离线文案锁死在「网络未连接」——Maestro flow `07b-network-offline.yaml` 断言该串，
 * 而 flow 树的哈希被四槽证据回执（HMAC 封签）钉住，改文案必须连带重新封签证据夹具。
 */
export function ConnectionBanner({ connectionState, isOnline }: ConnectionBannerProps) {
  const showBanner =
    !isOnline || connectionState === 'reconnecting' || connectionState === 'disconnected';
  const slideAnim = useRef(new Animated.Value(showBanner ? 0 : -BANNER_HEIGHT)).current;
  const reconnecting = isOnline && connectionState === 'reconnecting';
  const spinStyle = useSpinStyle(reconnecting && showBanner);

  useEffect(() => {
    const anim = Animated.timing(slideAnim, {
      toValue: showBanner ? 0 : -BANNER_HEIGHT,
      duration: 250,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [showBanner, slideAnim]);

  const label = !isOnline
    ? '网络未连接'
    : connectionState === 'reconnecting'
      ? '重新连接中...'
      : connectionState === 'disconnected'
        ? '连接已断开'
        : '';

  const styles = useThemedStyles((colors) => {
    const family = connectionState === 'disconnected' && isOnline
      ? colors.dangerFamily
      : colors.warningFamily;
    return {
      banner: {
        position: 'absolute' as const,
        top: 0,
        left: 0,
        right: 0,
        height: BANNER_HEIGHT,
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        gap: spacing.sm,
        zIndex: 100,
        backgroundColor: family.DEFAULT,
      },
      text: {
        ...fontScale.xs,
        fontWeight: fontWeight.medium,
        color: family.foreground,
      },
    };
  });

  const iconColor = StyleSheet.flatten(styles.text).color;

  return (
    <Animated.View
      testID="connection-banner"
      accessibilityRole="alert"
      accessibilityLabel={label}
      style={[
        styles.banner,
        { transform: [{ translateY: slideAnim }] },
        reconnecting ? { opacity: RECONNECTING_OPACITY } : null,
      ]}
      pointerEvents="none"
    >
      {reconnecting ? (
        <ReAnimated.View style={spinStyle}>
          <Loader2 size={ICON_SIZE.inline} color={iconColor} strokeWidth={ICON_STROKE.default} />
        </ReAnimated.View>
      ) : null}
      <View>
        <Text style={styles.text} testID="connection-banner-label">{label}</Text>
      </View>
    </Animated.View>
  );
}
