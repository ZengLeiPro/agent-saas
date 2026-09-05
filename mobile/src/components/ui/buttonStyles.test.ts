/**
 * Button 变体 / 尺寸映射测试。
 *
 * 基元的价值在于「一个变体永远解析到同一组 token」——一旦有人把 primary
 * 改成写死的蓝色或让 destructive 落到 warning 族，这里必须先红。
 */
import { describe, expect, it } from 'vitest';
import { darkColors, lightColors } from '../../theme/colors';
import {
  BUTTON_DISABLED_OPACITY,
  isBareVariant,
  resolveButtonSize,
  resolveButtonVariant,
  type ButtonVariant,
} from './buttonStyles';

/** 递归收集一套主题里出现过的全部颜色字符串 */
function collectColorValues(node: unknown, sink = new Set<string>()): Set<string> {
  if (typeof node === 'string') sink.add(node);
  else if (Array.isArray(node)) node.forEach((item) => collectColorValues(item, sink));
  else if (node && typeof node === 'object') {
    Object.values(node).forEach((item) => collectColorValues(item, sink));
  }
  return sink;
}

const ALL_VARIANTS: ButtonVariant[] = [
  'primary',
  'secondary',
  'outline',
  'ghost',
  'destructive',
  'link',
];

describe('resolveButtonVariant', () => {
  it('主 CTA 用品牌蓝实底 + 反色文字', () => {
    const tokens = resolveButtonVariant('primary', lightColors);
    expect(tokens.backgroundColor).toBe(lightColors.primary);
    expect(tokens.foreground).toBe(lightColors.primaryForeground);
    expect(tokens.borderWidth).toBe(0);
    expect(tokens.underline).toBe(false);
  });

  it('destructive 走 destructive 族而不是 warning 族', () => {
    const tokens = resolveButtonVariant('destructive', lightColors);
    expect(tokens.backgroundColor).toBe(lightColors.destructive);
    expect(tokens.foreground).toBe(lightColors.destructiveForeground);
    expect(tokens.backgroundColor).not.toBe(lightColors.warning);
  });

  it('outline 是卡片底 + input 边框，ghost / link 不带底色', () => {
    const outline = resolveButtonVariant('outline', lightColors);
    expect(outline.backgroundColor).toBe(lightColors.card);
    expect(outline.borderColor).toBe(lightColors.input);
    expect(outline.borderWidth).toBeGreaterThan(0);

    expect(resolveButtonVariant('ghost', lightColors).backgroundColor).toBeUndefined();
    expect(resolveButtonVariant('link', lightColors).backgroundColor).toBeUndefined();
  });

  it('link 用链接色并带下划线，且是唯一的 bare 变体', () => {
    const tokens = resolveButtonVariant('link', lightColors);
    expect(tokens.foreground).toBe(lightColors.link);
    expect(tokens.underline).toBe(true);
    expect(ALL_VARIANTS.filter(isBareVariant)).toEqual(['link']);
  });

  it('每个变体解析出的颜色都来自入参 token，没有写死的字面量色值', () => {
    for (const colors of [lightColors, darkColors]) {
      const known = collectColorValues(colors);
      for (const variant of ALL_VARIANTS) {
        const tokens = resolveButtonVariant(variant, colors);
        expect(tokens.foreground).toBeTruthy();
        for (const key of [
          'backgroundColor',
          'pressedBackgroundColor',
          'foreground',
          'borderColor',
        ] as const) {
          const value = tokens[key];
          if (value === undefined) continue;
          expect(known.has(value)).toBe(true);
        }
      }
    }
    // 亮/暗必须解析出不同的主色，证明确实读的是入参 token 而非常量
    expect(resolveButtonVariant('primary', lightColors).backgroundColor).not.toBe(
      resolveButtonVariant('primary', darkColors).backgroundColor,
    );
  });
});

describe('resolveButtonSize', () => {
  it('三档高度递增，且都满足 ≥36 的可点区域', () => {
    const sm = resolveButtonSize('sm');
    const md = resolveButtonSize('md');
    const lg = resolveButtonSize('lg');
    expect(sm.minHeight).toBeGreaterThanOrEqual(36);
    expect(md.minHeight).toBeGreaterThan(sm.minHeight);
    expect(lg.minHeight).toBeGreaterThan(md.minHeight);
  });

  it('字号只取 fontScale 档位（11/12/14/16/18/20/24 之一）', () => {
    const allowed = [11, 12, 14, 16, 18, 20, 24];
    for (const size of ['sm', 'md', 'lg'] as const) {
      expect(allowed).toContain(resolveButtonSize(size).text.fontSize);
    }
  });
});

it('disabled 透明度与 Web disabled:opacity-50 对齐', () => {
  expect(BUTTON_DISABLED_OPACITY).toBe(0.5);
});
