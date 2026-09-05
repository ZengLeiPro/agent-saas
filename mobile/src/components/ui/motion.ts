/**
 * 基元集共用的两个 reanimated 动画：持续旋转（Loader2 / running 状态）与呼吸（Skeleton）。
 *
 * 两者都遵守系统「减少动态效果」开关：开启时返回静态样式，不启动任何循环动画。
 */
import { useEffect } from 'react';
import {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

const SPIN_DURATION_MS = 900;
const PULSE_DURATION_MS = 900;
const PULSE_MIN_OPACITY = 0.4;

/** 360° 匀速旋转 */
export function useSpinStyle(active = true) {
  const reduceMotion = useReducedMotion();
  const angle = useSharedValue(0);

  useEffect(() => {
    if (!active || reduceMotion) {
      cancelAnimation(angle);
      angle.value = 0;
      return;
    }
    angle.value = 0;
    angle.value = withRepeat(
      withTiming(360, { duration: SPIN_DURATION_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(angle);
  }, [active, reduceMotion, angle]);

  return useAnimatedStyle(() => ({ transform: [{ rotate: `${angle.value}deg` }] }));
}

/** 透明度呼吸（对齐 Web `animate-pulse`） */
export function usePulseStyle(active = true) {
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (!active || reduceMotion) {
      cancelAnimation(opacity);
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(
      withTiming(PULSE_MIN_OPACITY, {
        duration: PULSE_DURATION_MS,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      true,
    );
    return () => cancelAnimation(opacity);
  }, [active, reduceMotion, opacity]);

  return useAnimatedStyle(() => ({ opacity: opacity.value }));
}
