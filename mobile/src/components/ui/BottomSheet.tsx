import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { X } from 'lucide-react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { Easing, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors, spacing, radius, fontScale, fontWeight } from '../../theme';
import { bottomSheetLayout, type BottomSheetSnap } from './bottomSheetLayout';

export type { BottomSheetSnap } from './bottomSheetLayout';
export interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  snap?: BottomSheetSnap;
  children?: React.ReactNode;
  showHandle?: boolean;
  showCloseButton?: boolean;
  testID?: string;
}
const ENTER_MS = 220;
const EXIT_MS = 180;
const DISMISS_DISTANCE = 88;
const DISMISS_VELOCITY = 800;

export function BottomSheet({ visible, onClose, title, snap = 'auto', children,
  showHandle = true, showCloseButton = true, testID }: BottomSheetProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const [rendered, setRendered] = useState(visible);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const animationGeneration = useRef(0);
  const progress = useSharedValue(0);
  const dragOffset = useSharedValue(0);
  const sheetHeight = useSharedValue(screenHeight);
  const layout = bottomSheetLayout(screenHeight, insets.top, insets.bottom, snap);

  const finishDismiss = useCallback((generation: number) => {
    if (generation === animationGeneration.current && !visibleRef.current) setRendered(false);
  }, []);

  useEffect(() => {
    const generation = ++animationGeneration.current;
    if (visible) {
      setRendered(true);
      dragOffset.value = 0;
      // Animate progress, not an onLayout-dependent offset: reopening an unchanged sheet still enters.
      progress.value = withTiming(1, { duration: reduceMotion ? 0 : ENTER_MS, easing: Easing.out(Easing.cubic) });
    } else {
      progress.value = withTiming(0, { duration: reduceMotion ? 0 : EXIT_MS, easing: Easing.in(Easing.cubic) }, (finished) => {
        'worklet';
        if (finished) runOnJS(finishDismiss)(generation);
      });
    }
  }, [visible, reduceMotion, progress, dragOffset, finishDismiss]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    if (event.nativeEvent.layout.height > 0) sheetHeight.value = event.nativeEvent.layout.height;
  }, [sheetHeight]);

  // Only the header owns dismiss gestures. Vertical content and horizontal tables keep their own scrolling.
  const dragGesture = Gesture.Pan().activeOffsetY(8)
    .onUpdate((event) => { dragOffset.value = Math.max(0, event.translationY); })
    .onEnd((event) => {
      if (event.translationY > DISMISS_DISTANCE || event.velocityY > DISMISS_VELOCITY) {
        runOnJS(onClose)();
      } else {
        dragOffset.value = withTiming(0, { duration: reduceMotion ? 0 : EXIT_MS });
      }
    })
    .onFinalize((_event, success) => {
      if (!success) dragOffset.value = withTiming(0, { duration: reduceMotion ? 0 : EXIT_MS });
    });
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * sheetHeight.value + dragOffset.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: progress.value * (1 - Math.min(0.75, dragOffset.value / Math.max(1, sheetHeight.value))),
  }));

  if (!rendered) return null;
  return (
    <Modal transparent visible animationType="none" presentationStyle="overFullScreen"
      statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}>
      <GestureHandlerRootView style={styles.root}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }, backdropStyle]}>
          <Pressable testID={testID ? `${testID}-backdrop` : undefined} accessibilityRole="button"
            accessibilityLabel="关闭" style={StyleSheet.absoluteFill} onPress={onClose} disabled={!visible} />
        </Animated.View>
        <Animated.View testID={testID} onLayout={handleLayout} accessibilityViewIsModal
          onAccessibilityEscape={onClose} pointerEvents={visible ? 'auto' : 'none'}
          style={[styles.sheet, layout.sizing, { backgroundColor: colors.card, borderColor: colors.border,
            paddingBottom: layout.paddingBottom }, sheetStyle]}>
          <GestureDetector gesture={dragGesture}>
            <View style={styles.grabArea}>
              {showHandle ? <View testID={testID ? `${testID}-handle` : undefined}
                style={[styles.handle, { backgroundColor: colors.borderStrong }]} /> : null}
              {title || showCloseButton ? (
                <View style={styles.header}>
                  <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]} numberOfLines={2}>{title}</Text>
                  {showCloseButton ? (
                    <Pressable testID={testID ? `${testID}-close` : undefined} accessibilityRole="button"
                      accessibilityLabel={title ? `关闭${title}` : '关闭'} onPress={onClose} hitSlop={4}
                      style={({ pressed }) => [styles.close, { backgroundColor: pressed ? colors.muted : colors.secondary }]}>
                      <X size={18} color={colors.mutedForeground} />
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </View>
          </GestureDetector>
          {title ? <View style={[styles.divider, { backgroundColor: colors.border }]} /> : null}
          <View testID={testID ? `${testID}-body` : undefined} style={[styles.body, layout.fixedHeight && styles.fixedBody]}>
            {children}
          </View>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius['2xl'], borderTopRightRadius: radius['2xl'],
    borderTopWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  grabArea: { alignItems: 'center', paddingTop: spacing.sm, paddingHorizontal: spacing.md },
  handle: { width: 36, height: 4, borderRadius: radius.full, marginBottom: spacing.xs },
  header: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.sm },
  title: { ...fontScale.base, fontWeight: fontWeight.semibold, flex: 1, minWidth: 0 },
  close: { minWidth: 44, minHeight: 44, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
  divider: { height: StyleSheet.hairlineWidth },
  body: { flexShrink: 1, minHeight: 0 },
  fixedBody: { flex: 1 },
});
