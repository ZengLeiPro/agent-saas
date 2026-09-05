/**
 * 行滑动动作的手感参数 —— 与 Web `web/src/components/mobile/SwipeableRow.tsx` 对齐。
 *
 * Web 侧是 CSS transition（固定 200ms 缓动曲线），RN 侧 gesture-handler 的
 * Swipeable 只接受弹簧参数，因此这里把「200ms 内停稳且不回弹」翻译成一组
 * 临界阻尼弹簧常量：ω = 2π/duration * ANGULAR_FACTOR，damping = 2√(k·m)。
 */

/** 单个动作按钮宽度（pt） */
export const SWIPE_ACTION_WIDTH = 72;
/** 松手后吸附到打开态所需的拖动比例 */
export const SWIPE_THRESHOLD_RATIO = 0.4;
/** 吸附动画时长（ms） */
export const SWIPE_ANIMATION_MS = 200;

export interface SwipeSpringConfig extends Record<string, unknown> {
  stiffness: number;
  damping: number;
  mass: number;
  overshootClamping: boolean;
}

/** 目标时长 → 临界阻尼弹簧参数（mass 固定 1，overshootClamping 保证不回弹）。 */
export function resolveSwipeSpringConfig(durationMs = SWIPE_ANIMATION_MS): SwipeSpringConfig {
  const mass = 1;
  // 临界阻尼下位移在 ~4/ω 内收敛；取 ω = 4000 / durationMs 使收敛时间约等于 durationMs。
  const omega = 4000 / durationMs;
  const stiffness = Math.round(omega * omega * mass);
  return {
    stiffness,
    damping: Math.round(2 * Math.sqrt(stiffness * mass)),
    mass,
    overshootClamping: true,
  };
}

/** 打开态需要拖动的距离（pt）：动作总宽 × 阈值比例。 */
export function resolveSwipeOpenThreshold(
  actionCount: number,
  actionWidth = SWIPE_ACTION_WIDTH,
): number {
  return actionCount * actionWidth * SWIPE_THRESHOLD_RATIO;
}
