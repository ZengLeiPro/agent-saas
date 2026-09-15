import { describe, expect, it } from 'vitest';
import { DESKTOP_PRIMARY_MIN_WIDTH, RIGHT_PANE_DIVIDER_WIDTH } from './layoutProtection';
import {
  RIGHT_PANE_RATIO_DEFAULT,
  RIGHT_PANE_RATIO_MAX,
  RIGHT_PANE_RATIO_MIN,
  RIGHT_PANE_WIDTH_MIN_PX,
  applyRightPaneResizeDelta,
  clampRightPaneRatio,
  clampRightPaneWidth,
  rightPaneRatioFromWidth,
  rightPaneWidthFromRatio,
} from './rightPaneResize';

describe('rightPaneResize', () => {
  it('clamps ratio into 25–75%', () => {
    expect(clampRightPaneRatio(0.1)).toBe(RIGHT_PANE_RATIO_MIN);
    expect(clampRightPaneRatio(0.9)).toBe(RIGHT_PANE_RATIO_MAX);
    expect(clampRightPaneRatio(0.35)).toBe(RIGHT_PANE_RATIO_DEFAULT);
    expect(clampRightPaneRatio(Number.NaN)).toBe(RIGHT_PANE_RATIO_DEFAULT);
  });

  it('converts ratio ↔ width', () => {
    expect(rightPaneWidthFromRatio(1000, 0.35)).toBe(350);
    expect(rightPaneRatioFromWidth(1000, 350)).toBe(0.35);
    expect(rightPaneWidthFromRatio(0, 0.35)).toBe(0);
  });

  it('clamps absolute width into ratio band and min main budget', () => {
    // host 1200 → 25–75% = 300–900, maxPx 736, main≥640 → max 1200-640-1=559
    expect(
      clampRightPaneWidth({
        hostWidth: 1200,
        desiredWidth: 900,
        minMainWidth: DESKTOP_PRIMARY_MIN_WIDTH,
      }),
    ).toBe(1200 - DESKTOP_PRIMARY_MIN_WIDTH - RIGHT_PANE_DIVIDER_WIDTH);

    expect(
      clampRightPaneWidth({
        hostWidth: 1200,
        desiredWidth: 100,
        minMainWidth: DESKTOP_PRIMARY_MIN_WIDTH,
      }),
    ).toBe(Math.max(RIGHT_PANE_WIDTH_MIN_PX, Math.round(1200 * RIGHT_PANE_RATIO_MIN)));

    expect(
      clampRightPaneWidth({
        hostWidth: 1200,
        desiredWidth: 380,
        minMainWidth: DESKTOP_PRIMARY_MIN_WIDTH,
      }),
    ).toBe(380);
  });

  it('applies drag delta (right shrinks pane)', () => {
    expect(
      applyRightPaneResizeDelta({
        hostWidth: 1200,
        currentWidth: 400,
        deltaX: 40,
      }),
    ).toBe(360);
    expect(
      applyRightPaneResizeDelta({
        hostWidth: 1200,
        currentWidth: 400,
        deltaX: -40,
      }),
    ).toBe(440);
  });
});
