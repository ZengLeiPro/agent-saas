import React, { useEffect, useRef, useMemo } from 'react';
import { View, StyleSheet, Animated } from 'react-native';
import { useColors, spacing, radius } from '../theme';
import type { ThemeColors } from '../theme';

function SkeletonRow({ colors }: { colors: ThemeColors }) {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  const styles = useMemo(() => StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      // 与 SessionRow 样式保持一致，避免 SkeletonList → FlashList 切换时的视觉跳动
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
    },
    avatarSkeleton: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: colors.muted,
      marginRight: spacing.md,
    },
    rowInner: {
      flex: 1,
      marginRight: spacing.sm,
      gap: 6,
    },
    titleBar: {
      height: 14,
      width: '60%',
      backgroundColor: colors.muted,
      borderRadius: radius.sm,
    },
    previewBar: {
      height: 10,
      width: '85%',
      backgroundColor: colors.muted,
      borderRadius: radius.sm,
    },
    timeBar: {
      height: 10,
      width: 40,
      backgroundColor: colors.muted,
      borderRadius: radius.sm,
    },
  }), [colors]);

  return (
    <View style={styles.row}>
      <Animated.View style={[styles.avatarSkeleton, { opacity }]} />
      <View style={styles.rowInner}>
        <Animated.View style={[styles.titleBar, { opacity }]} />
        <Animated.View style={[styles.previewBar, { opacity }]} />
      </View>
      <Animated.View style={[styles.timeBar, { opacity }]} />
    </View>
  );
}

export function SkeletonList({ count = 8 }: { count?: number }) {
  const colors = useColors();

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.card,
    },
  }), [colors]);

  return (
    <View style={styles.container}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRow key={i} colors={colors} />
      ))}
    </View>
  );
}
