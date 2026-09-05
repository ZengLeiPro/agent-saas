import { describe, expect, it } from 'vitest';

import { lightColors } from '../../../theme/colors';
import { resolveActivityToneTokens, resolvePresentationToneTokens, toneBadgeVariant } from './tone';

describe('resolveActivityToneTokens', () => {
  it('语义四族各自落到 DEFAULT / subtle / ink 三支', () => {
    expect(resolveActivityToneTokens('success', lightColors)).toEqual({
      tint: lightColors.successFamily.DEFAULT,
      subtle: lightColors.successFamily.subtle,
      ink: lightColors.successFamily.ink,
    });
    expect(resolveActivityToneTokens('warning', lightColors).ink).toBe(
      lightColors.warningFamily.ink,
    );
    expect(resolveActivityToneTokens('danger', lightColors).tint).toBe(
      lightColors.dangerFamily.DEFAULT,
    );
  });

  it('active 走 info 族而非品牌主色——品牌蓝只留给主 CTA', () => {
    expect(resolveActivityToneTokens('active', lightColors).tint).toBe(
      lightColors.infoFamily.DEFAULT,
    );
    expect(resolveActivityToneTokens('active', lightColors).tint).not.toBe(lightColors.primary);
  });

  it('pending 与 neutral 同为静音灰，不抢视线', () => {
    expect(resolveActivityToneTokens('pending', lightColors)).toEqual(
      resolveActivityToneTokens('neutral', lightColors),
    );
  });
});

describe('resolvePresentationToneTokens', () => {
  it('呈现块语气经 shared 映射表转成同一批 token', () => {
    expect(resolvePresentationToneTokens('warn', lightColors)).toEqual(
      resolveActivityToneTokens('warning', lightColors),
    );
    expect(resolvePresentationToneTokens('info', lightColors)).toEqual(
      resolveActivityToneTokens('active', lightColors),
    );
    expect(resolvePresentationToneTokens('muted', lightColors)).toEqual(
      resolveActivityToneTokens('pending', lightColors),
    );
  });
});

describe('toneBadgeVariant', () => {
  it('徽章与圆点同族取色', () => {
    expect(toneBadgeVariant('active')).toBe('info');
    expect(toneBadgeVariant('success')).toBe('success');
    expect(toneBadgeVariant('warning')).toBe('warning');
    expect(toneBadgeVariant('danger')).toBe('danger');
    expect(toneBadgeVariant('pending')).toBe('secondary');
    expect(toneBadgeVariant('neutral')).toBe('secondary');
  });
});
