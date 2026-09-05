import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors, spacing, radius, fontScale, fontWeight } from '../../theme';

/** 高度档位：auto 由内容撑开（上限 85%），half/full 固定比例 */
export type BottomSheetSnap = 'auto' | 'half' | 'full';

export interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  snap?: BottomSheetSnap;
  children?: React.ReactNode;
  /** 是否显示顶部拖拽把手（默认显示） */
  showHandle?: boolean;
  testID?: string;
}

const ENTER_MS = 220;
const EXIT_MS = 180;
/** 首帧尚未测得高度时的兜底位移 */
const FALLBACK_OFFSET = 900;
const DISMISS_DISTANCE = 88;
const DISMISS_VELOCITY = 800;

export function BottomSheet({
  visible,
  onClose,
  title,
  snap = 'auto',
  children,
  showHandle = true,
  testID,
}: BottomSheetProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const reduceMotion = useReducedMotion();

  const [rendered, setRendered] = useState(visible);
  const translateY = useSharedValue(FALLBACK_OFFSET);
  const backdropOpacity = useSharedValue(0);
  const sheetHeight = useSharedValue(FALLBACK_OFFSET);
  const enteredRef = useRef(false);

  useEffect(() => {
    if (visible) {
      enteredRef.current = false;
      translateY.value = FALLBACK_OFFSET;
      backdropOpacity.value = reduceMotion ? 1 : withTiming(1, { duration: ENTER_MS });
      setRendered(true);
      return;
    }
    if (reduceMotion) {
      backdropOpacity.value = 0;
      setRendered(false);
      return;
    }
    backdropOpacity.value = withTiming(0, { duration: EXIT_MS });
    translateY.value = withTiming(
      sheetHeight.value,
      { duration: EXIT_MS, easing: Easing.in(Easing.cubic) },
      (finished) => {
        'worklet';
        if (finished !== false) runOnJS(setRendered)(false);
      },
    );
  }, [visible, reduceMotion, translateY, backdropOpacity, sheetHeight]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      if (height <= 0) return;
      sheetHeight.value = height;
      if (enteredRef.current) return;
      enteredRef.current = true;
      if (reduceMotion) {
        translateY.value = 0;
        return;
      }
      translateY.value = height;
      translateY.value = withTiming(0, { duration: ENTER_MS, easing: Easing.out(Easing.cubic) });
    },
    [reduceMotion, sheetHeight, translateY],
  );

  const dragGesture = Gesture.Pan()
    .onUpdate((event) => {
      translateY.value = Math.max(0, event.translationY);
    })
    .onEnd((event) => {
      if (event.translationY > DISMISS_DISTANCE || event.velocityY > DISMISS_VELOCITY) {
        runOnJS(onClose)();
        return;
      }
      translateY.value = withTiming(0, { duration: EXIT_MS });
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdropOpacity.value }));

  if (!rendered) return null;

  const sizing =
    snap === 'half'
      ? { height: Math.round(screenHeight * 0.5) }
      : snap === 'full'
        ? { height: Math.round(screenHeight * 0.9) }
        : { maxHeight: Math.round(screenHeight * 0.85) };

  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.root}>
        <Animated.View
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }, backdropStyle]}
        >
          <Pressable
            testID={testID ? `${testID}-backdrop` : undefined}
            accessibilityLabel="关闭"
            style={StyleSheet.absoluteFill}
            onPress={onClose}
          />
        </Animated.View>
        <Animated.View
          testID={testID}
          onLayout={handleLayout}
          style={[
            styles.sheet,
            sizing,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              paddingBottom: insets.bottom + spacing.sm,
            },
            sheetStyle,
          ]}
        >
          <GestureDetector gesture={dragGesture}>
            <View style={styles.grabArea}>
              {showHandle ? (
                <View style={[styles.handle, { backgroundColor: colors.borderStrong }]} />
              ) : null}
              {title ? (
                <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
                  {title}
                </Text>
              ) : null}
            </View>
          </GestureDetector>
          {title ? <View style={[styles.divider, { backgroundColor: colors.border }]} /> : null}
          <View style={styles.body}>{children}</View>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: radius['2xl'],
    borderTopRightRadius: radius['2xl'],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  grabArea: {
    alignItems: 'center',
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: radius.full,
  },
  title: {
    ...fontScale.base,
    fontWeight: fontWeight.semibold,
    paddingBottom: spacing.sm,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  body: {
    flexShrink: 1,
  },
});
