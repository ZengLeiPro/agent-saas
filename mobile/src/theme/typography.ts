import { Platform, TextStyle } from 'react-native';

/**
 * 字号阶梯 —— 与 Web `web/tailwind.config.ts` fontSize 一比一对齐（唯一合法档位）。
 *
 * | 档位 | px / lineHeight | Web 用途 |
 * | ---- | --------------- | -------- |
 * | xs2  | 11 / 16 | 密集元信息（徽章、时间线 meta） |
 * | xs   | 12 / 16 | 表格与后台正文 |
 * | sm   | 14 / 20 | 卡片标题、表单 |
 * | base | 16 / 24 | 聊天正文 |
 * | lg   | 18 / 28 | 区块标题 |
 * | xl   | 20 / 28 | 页面标题 |
 * | xl2  | 24 / 32 | 指标卡数值、页标题 |
 *
 * 业务组件不得写 `fontSize:` 字面量；需要更小的字号一律 `xs2`。
 */
export const fontScale = {
  xs2: { fontSize: 11, lineHeight: 16 },
  xs: { fontSize: 12, lineHeight: 16 },
  sm: { fontSize: 14, lineHeight: 20 },
  base: { fontSize: 16, lineHeight: 24 },
  lg: { fontSize: 18, lineHeight: 28 },
  xl: { fontSize: 20, lineHeight: 28 },
  xl2: { fontSize: 24, lineHeight: 32 },
} as const;

export type FontScaleKey = keyof typeof fontScale;

/** 等宽栈：与 Web fontFamily.mono 意图一致（ID / token 数 / 代码片段） */
export const monoFamily = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const satisfies Record<string, TextStyle['fontWeight']>;

/**
 * 语义排版（legacy 名保留，值已对齐阶梯）：
 * title=xl / subtitle=base semibold / body=base / bodySmall=sm / caption=xs / mono=sm mono。
 */
export const typography = {
  title: { ...fontScale.xl, fontWeight: fontWeight.semibold } as TextStyle,
  subtitle: { ...fontScale.base, fontWeight: fontWeight.semibold } as TextStyle,
  body: { ...fontScale.base, fontWeight: fontWeight.regular } as TextStyle,
  bodySmall: { ...fontScale.sm, fontWeight: fontWeight.regular } as TextStyle,
  caption: { ...fontScale.xs, fontWeight: fontWeight.regular } as TextStyle,
  /** 密集元信息（Web `text-2xs`） */
  meta: { ...fontScale.xs2, fontWeight: fontWeight.regular } as TextStyle,
  /** 区块标题（Web `text-lg`） */
  heading: { ...fontScale.lg, fontWeight: fontWeight.semibold } as TextStyle,
  /** 指标数值 / 大标题（Web `text-2xl`） */
  display: { ...fontScale.xl2, fontWeight: fontWeight.semibold } as TextStyle,
  mono: { ...fontScale.sm, fontFamily: monoFamily } as TextStyle,
};
