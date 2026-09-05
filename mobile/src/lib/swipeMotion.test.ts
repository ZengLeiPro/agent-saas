import { describe, expect, it } from 'vitest';
import {
  SWIPE_ACTION_WIDTH,
  SWIPE_ANIMATION_MS,
  SWIPE_THRESHOLD_RATIO,
  resolveSwipeOpenThreshold,
  resolveSwipeSpringConfig,
} from './swipeMotion';

describe('swipeMotion', () => {
  it('参数与 Web SwipeableRow 一致', () => {
    expect(SWIPE_ACTION_WIDTH).toBe(72);
    expect(SWIPE_THRESHOLD_RATIO).toBe(0.4);
    expect(SWIPE_ANIMATION_MS).toBe(200);
  });

  it('默认弹簧为临界阻尼且不回弹', () => {
    const config = resolveSwipeSpringConfig();
    expect(config.mass).toBe(1);
    expect(config.overshootClamping).toBe(true);
    expect(config.damping).toBe(Math.round(2 * Math.sqrt(config.stiffness * config.mass)));
  });

  it('时长越短刚度越大', () => {
    expect(resolveSwipeSpringConfig(100).stiffness).toBeGreaterThan(
      resolveSwipeSpringConfig(400).stiffness,
    );
  });

  it('打开阈值 = 动作总宽 × 0.4', () => {
    expect(resolveSwipeOpenThreshold(3)).toBeCloseTo(86.4);
    expect(resolveSwipeOpenThreshold(2, 100)).toBeCloseTo(80);
  });
});
