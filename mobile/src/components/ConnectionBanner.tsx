import React, { useEffect, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import type { ConnectionState } from '@agent/shared';
import { useColors, spacing, typography } from '../theme';

interface ConnectionBannerProps {
  connectionState: ConnectionState;
  isOnline: boolean;
}

export function ConnectionBanner({ connectionState, isOnline }: ConnectionBannerProps) {
  const colors = useColors();
  const showBanner = !isOnline || connectionState === 'reconnecting' || connectionState === 'disconnected';
  const slideAnim = useRef(new Animated.Value(showBanner ? 0 : -40)).current;

  useEffect(() => {
    const anim = Animated.timing(slideAnim, {
      toValue: showBanner ? 0 : -40,
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

  const bgColor = !isOnline || connectionState === 'disconnected'
    ? colors.destructive
    : colors.statusIcon.warning;

  const styles = useMemo(() => StyleSheet.create({
    banner: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 100,
    },
    text: {
      ...typography.caption,
      color: colors.primaryForeground,
      fontWeight: '600',
    },
  }), [colors]);

  return (
    <Animated.View
      style={[
        styles.banner,
        { backgroundColor: bgColor, transform: [{ translateY: slideAnim }] },
      ]}
      pointerEvents="none"
    >
      <Text style={styles.text}>{label}</Text>
    </Animated.View>
  );
}
