import { describe, expect, it } from 'vitest';

import { PRESENTATION_TONE_TO_ACTIVITY, formatActivityDuration } from './activityStatusTone';

describe('formatActivityDuration', () => {
  it('1 秒以内给毫秒原值', () => {
    expect(formatActivityDuration(0)).toBe('0ms');
    expect(formatActivityDuration(999)).toBe('999ms');
  });

  it('1 分钟以内给秒；10 秒以内保留一位小数', () => {
    expect(formatActivityDuration(1000)).toBe('1.0s');
    expect(formatActivityDuration(9_500)).toBe('9.5s');
    expect(formatActivityDuration(12_400)).toBe('12s');
  });

  it('分钟与小时档去掉多余的 .0', () => {
    expect(formatActivityDuration(90_000)).toBe('1.5m');
    expect(formatActivityDuration(60_000)).toBe('1m');
    expect(formatActivityDuration(3_600_000)).toBe('1h');
  });

  it('非法值返回 null，调用方据此隐藏耗时位而不是显示 NaN', () => {
    expect(formatActivityDuration(undefined)).toBeNull();
    expect(formatActivityDuration(Number.NaN)).toBeNull();
    expect(formatActivityDuration(-1)).toBeNull();
    expect(formatActivityDuration(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('PRESENTATION_TONE_TO_ACTIVITY', () => {
  it('覆盖 6 种呈现块语气且映射与 Web TONE_MAP 一致', () => {
    expect(PRESENTATION_TONE_TO_ACTIVITY).toEqual({
      neutral: 'neutral',
      info: 'active',
      success: 'success',
      warn: 'warning',
      danger: 'danger',
      muted: 'pending',
    });
  });
});
