/**
 * Badge 变体映射测试：重点是语义四族必须是「subtle 底 + ink 文字」的浅底深字，
 * 不允许有人把某一族偷偷换成实心底（那会让列表里的徽章喧宾夺主）。
 */
import { describe, expect, it } from 'vitest';
import { darkColors, lightColors } from '../../theme/colors';
import { resolveBadgeSize, resolveBadgeVariant, type BadgeVariant } from './badgeStyles';

const SEMANTIC: {
  variant: BadgeVariant;
  family: 'successFamily' | 'warningFamily' | 'dangerFamily' | 'infoFamily';
}[] = [
  { variant: 'success', family: 'successFamily' },
  { variant: 'warning', family: 'warningFamily' },
  { variant: 'danger', family: 'dangerFamily' },
  { variant: 'info', family: 'infoFamily' },
];

describe('resolveBadgeVariant', () => {
  it.each(SEMANTIC)('$variant 映射到 $family 的 subtle 底 + ink 字', ({ variant, family }) => {
    for (const colors of [lightColors, darkColors]) {
      const tokens = resolveBadgeVariant(variant, colors);
      expect(tokens.backgroundColor).toBe(colors[family].subtle);
      expect(tokens.foreground).toBe(colors[family].ink);
      expect(tokens.borderWidth).toBe(0);
      // 浅底深字：不得落到实心 DEFAULT 上
      expect(tokens.backgroundColor).not.toBe(colors[family].DEFAULT);
    }
  });

  it('四族互不串色', () => {
    const backgrounds = SEMANTIC.map(
      ({ variant }) => resolveBadgeVariant(variant, lightColors).backgroundColor,
    );
    expect(new Set(backgrounds).size).toBe(SEMANTIC.length);
  });

  it('结构档走 shadcn 结构色，outline 只有边框没有底', () => {
    expect(resolveBadgeVariant('default', lightColors).backgroundColor).toBe(lightColors.primary);
    expect(resolveBadgeVariant('secondary', lightColors).backgroundColor).toBe(
      lightColors.secondary,
    );

    const outline = resolveBadgeVariant('outline', lightColors);
    expect(outline.backgroundColor).toBeUndefined();
    expect(outline.borderColor).toBe(lightColors.border);
    expect(outline.borderWidth).toBeGreaterThan(0);
  });
});

describe('resolveBadgeSize', () => {
  it('sm 比 md 更紧凑，且字号都取自 fontScale 的密集档', () => {
    const sm = resolveBadgeSize('sm');
    const md = resolveBadgeSize('md');
    expect(sm.paddingHorizontal).toBeLessThan(md.paddingHorizontal);
    expect(sm.text.fontSize).toBe(11);
    expect(md.text.fontSize).toBe(12);
  });
});
