import React, { useRef, useCallback, useEffect } from 'react';
import { View, Text, Animated, StyleSheet, TouchableOpacity, type StyleProp, type ViewStyle } from 'react-native';
import { Swipeable, RectButton } from 'react-native-gesture-handler';

export type { Swipeable };

export interface SwipeAction {
  key: string;
  label: string;
  backgroundColor: string;
  color: string;
  onPress: () => void;
  /** Wrap the action button (e.g. with DropdownMenu). Receives button content and a close callback. */
  renderWrapper?: (children: React.ReactNode, close: () => void) => React.ReactNode;
}

/** Width of the left-edge zone (in points) reserved for the native back gesture. */
const BACK_GESTURE_DEAD_ZONE = 24;

interface SwipeableRowProps {
  children: React.ReactNode;
  actions: SwipeAction[];
  actionWidth?: number;
  /** Shared ref across all rows to enforce single-open behavior */
  openRowRef: React.MutableRefObject<Swipeable | null>;
  containerStyle?: StyleProp<ViewStyle>;
  /**
   * When true, the internal PanGestureHandler will quickly fail on
   * left-to-right swipes so the native Stack navigator back gesture
   * can take over. Enable this on screens that sit inside a Stack
   * navigator and need edge-swipe-to-go-back.
   */
  enableBackGesture?: boolean;
}

export function SwipeableRow({
  children,
  actions,
  actionWidth = 72,
  openRowRef,
  containerStyle,
  enableBackGesture = false,
}: SwipeableRowProps) {
  const swipeRef = useRef<Swipeable>(null);
  const totalWidth = actions.length * actionWidth;

  const renderRightActions = useCallback(
    (progress: Animated.AnimatedInterpolation<number>) => {
      const translateX = progress.interpolate({
        inputRange: [0, 1],
        outputRange: [totalWidth, 0],
      });
      return (
        <Animated.View style={[styles.actionsRow, { width: totalWidth, transform: [{ translateX }] }]}>
          {actions.map((action) => {
            const btnStyle = [styles.actionBtn, { backgroundColor: action.backgroundColor, width: actionWidth }];
            const label = <Text style={[styles.actionLabel, { color: action.color }]}>{action.label}</Text>;

            if (action.renderWrapper) {
              return (
                <View key={action.key} style={{ width: actionWidth }}>
                  {action.renderWrapper(
                    <TouchableOpacity activeOpacity={0.7} style={[btnStyle, { flex: 1 }]}>
                      {label}
                    </TouchableOpacity>,
                    () => swipeRef.current?.close(),
                  )}
                </View>
              );
            }

            return (
              <RectButton
                key={action.key}
                style={btnStyle}
                onPress={() => {
                  swipeRef.current?.close();
                  action.onPress();
                }}
              >
                {label}
              </RectButton>
            );
          })}
        </Animated.View>
      );
    },
    [actions, actionWidth, totalWidth],
  );

  const handleOpen = useCallback(() => {
    if (openRowRef.current && openRowRef.current !== swipeRef.current) {
      openRowRef.current.close();
    }
    openRowRef.current = swipeRef.current;
  }, [openRowRef]);

  const handleClose = useCallback(() => {
    if (openRowRef.current === swipeRef.current) {
      openRowRef.current = null;
    }
  }, [openRowRef]);

  // 组件卸载时清理 openRowRef：防止分组等操作导致 SwipeableRow 在
  // 关闭动画完成前被卸载，onSwipeableClose 永远不触发，残留引用
  // 使所有列表项的 onPress 保护逻辑永远 early return。
  // 注意：必须在 setup 时捕获 swipeRef.current，因为 React 在 commit 阶段
  // 先清除子组件 ref（swipeRef.current = null），useEffect cleanup 晚于此运行。
  useEffect(() => {
    const instance = swipeRef.current;
    return () => {
      if (instance && openRowRef.current === instance) {
        openRowRef.current = null;
      }
    };
  }, [openRowRef]);

  // When back-gesture support is requested, configure the internal
  // PanGestureHandler so that left-to-right drags FAIL quickly (letting
  // the native navigator claim the gesture) while right-to-left drags
  // still activate normally for the swipe actions.
  //
  // • dragOffsetFromLeftEdge  – sets the positive end of activeOffsetX to
  //   a huge value, so a right-drag can never *activate* the handler.
  // • failOffsetX             – tells the handler to *fail* as soon as the
  //   finger travels BACK_GESTURE_DEAD_ZONE px to the right, releasing
  //   the gesture to the native back recognizer immediately.
  const backGestureProps = enableBackGesture
    ? {
        dragOffsetFromLeftEdge: 1e8,
        failOffsetX: BACK_GESTURE_DEAD_ZONE,
      }
    : undefined;

  return (
    <Swipeable
      ref={swipeRef}
      renderRightActions={renderRightActions}
      rightThreshold={40}
      overshootRight={false}
      onSwipeableOpen={handleOpen}
      onSwipeableClose={handleClose}
      containerStyle={containerStyle}
      {...backGestureProps}
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      {children as any}
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  actionsRow: {
    flexDirection: 'row',
  },
  actionBtn: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
});
