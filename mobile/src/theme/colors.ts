/**
 * 移动端颜色 token —— 与 Web 端 `web/src/index.css` / `web/tailwind.config.ts` 一比一对齐。
 *
 * 规则：
 * 1. 亮/暗两套值直接照抄 Web 的 HSL 变量（React Native 原生支持 `hsl()` 字符串），
 *    不做手工换算；Web 改 token，这里同步改，不允许各自演化。
 * 2. 业务组件只能引用本文件的语义 key，不得写字面量色值。
 * 3. 状态语义四族 success / warning / danger / info 各四支
 *    （DEFAULT / foreground / subtle / ink），与 Web 语义一致。
 * 4. 品牌蓝只出现在主 CTA、链接与选中态；橙色（brandAccent）只用于「用户=人」语境。
 */

export interface SemanticFamily {
  /** 实心块、圆点、进度条 */
  DEFAULT: string;
  /** 实心底上的文字 */
  foreground: string;
  /** 不透明浅底（横幅 / 告警条） */
  subtle: string;
  /** 浅底之上的文字色 */
  ink: string;
}

export interface ThemeColors {
  // ── 结构色（shadcn 桥接层）──
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  borderStrong: string;
  input: string;
  ring: string;

  // ── 状态语义四族 ──
  successFamily: SemanticFamily;
  warningFamily: SemanticFamily;
  dangerFamily: SemanticFamily;
  infoFamily: SemanticFamily;
  /** = successFamily.DEFAULT（向后兼容） */
  success: string;
  /** = warningFamily.DEFAULT（向后兼容） */
  warning: string;
  /** = dangerFamily.DEFAULT */
  danger: string;
  /** = infoFamily.DEFAULT */
  info: string;
  /** = successFamily.subtle（向后兼容） */
  successBg: string;
  /** = dangerFamily.subtle（向后兼容） */
  errorBg: string;

  // ── 品牌 ──
  brand: {
    50: string; 100: string; 200: string; 300: string; 400: string;
    500: string; 600: string; 700: string; 800: string; 900: string;
  };
  brandAccent: { DEFAULT: string; soft: string; ink: string };

  // ── 会话语境 ──
  link: string;
  userBubble: string;
  codeBlockBg: string;
  interrupted: string;
  /** 旧键，= muted（向后兼容，勿新增使用） */
  warm200: string;

  // ── 图表 / 分类色 ──
  chart: [string, string, string, string, string];

  // ── Overlay & shadow（亮/暗一致的物理色）──
  overlay: string;
  overlayHeavy: string;
  onOverlay: string;
  shadow: string;
  /** 品牌阴影色（iOS shadowColor + shadowOpacity 见 shadows） */
  shadowBrand: string;

  /** 行滑动快捷动作：与 Web `MobileSessionList` 动作语义对齐 */
  actions: {
    organize: string;
    edit: string;
    destructive: string;
    onAction: string;
  };
  /** 运行状态图标色 */
  statusIcon: {
    success: string;
    warning: string;
    info: string;
    purple: string;
    cyan: string;
  };
}

const BRAND = {
  50: '#EEF2FF',
  100: '#DDE5FF',
  200: '#BDCCFF',
  300: '#93A9FF',
  400: '#6480F6',
  500: '#3A61EE',
  600: '#2E56E1',
  700: '#2444C0',
  800: '#1F399B',
  900: '#1B327B',
} as const;

const BRAND_ACCENT = { DEFAULT: '#E8843A', soft: '#FDF2E8', ink: '#B65E16' } as const;

const PHYSICAL = {
  overlay: 'rgba(0,0,0,0.5)',
  overlayHeavy: 'rgba(0,0,0,0.9)',
  onOverlay: '#FFFFFF',
  shadow: '#000000',
  shadowBrand: '#2E56E1',
} as const;

// ── 亮色：对应 web/src/index.css `:root` ──
const lightSuccess: SemanticFamily = {
  DEFAULT: 'hsl(134, 100%, 35%)',
  foreground: 'hsl(0, 0%, 100%)',
  subtle: 'hsl(138, 60%, 95%)',
  ink: 'hsl(140, 90%, 24%)',
};
const lightWarning: SemanticFamily = {
  DEFAULT: 'hsl(26, 100%, 50%)',
  foreground: 'hsl(0, 0%, 100%)',
  subtle: 'hsl(34, 100%, 95%)',
  ink: 'hsl(26, 92%, 30%)',
};
const lightDanger: SemanticFamily = {
  DEFAULT: 'hsl(358, 90%, 60%)',
  foreground: 'hsl(0, 0%, 100%)',
  subtle: 'hsl(358, 100%, 96%)',
  ink: 'hsl(358, 72%, 42%)',
};
const lightInfo: SemanticFamily = {
  DEFAULT: 'hsl(212, 92%, 45%)',
  foreground: 'hsl(0, 0%, 100%)',
  subtle: 'hsl(208, 100%, 96%)',
  ink: 'hsl(214, 88%, 34%)',
};

export const lightColors: ThemeColors = {
  background: 'hsl(225, 75%, 98%)',
  foreground: 'hsl(0, 0%, 12%)',
  card: 'hsl(0, 0%, 100%)',
  cardForeground: 'hsl(0, 0%, 12%)',
  popover: 'hsl(0, 0%, 100%)',
  popoverForeground: 'hsl(0, 0%, 12%)',
  primary: 'hsl(227, 76%, 53%)',
  primaryForeground: 'hsl(0, 0%, 100%)',
  secondary: 'hsl(225, 75%, 98%)',
  secondaryForeground: 'hsl(0, 0%, 12%)',
  muted: 'hsl(225, 35%, 95%)',
  mutedForeground: 'hsl(0, 0%, 35%)',
  accent: 'hsl(225, 100%, 97%)',
  accentForeground: 'hsl(228, 69%, 45%)',
  destructive: 'hsl(358, 90%, 60%)',
  destructiveForeground: 'hsl(0, 0%, 100%)',
  border: 'hsl(220, 13%, 91%)',
  borderStrong: 'hsl(220, 13%, 84%)',
  input: 'hsl(220, 13%, 88%)',
  ring: 'hsl(220, 9%, 46%)',

  successFamily: lightSuccess,
  warningFamily: lightWarning,
  dangerFamily: lightDanger,
  infoFamily: lightInfo,
  success: lightSuccess.DEFAULT,
  warning: lightWarning.DEFAULT,
  danger: lightDanger.DEFAULT,
  info: lightInfo.DEFAULT,
  successBg: lightSuccess.subtle,
  errorBg: lightDanger.subtle,

  brand: BRAND,
  brandAccent: BRAND_ACCENT,

  link: 'hsl(227, 76%, 53%)',
  userBubble: 'hsl(28, 86%, 95%)',
  codeBlockBg: 'hsl(225, 60%, 97%)',
  interrupted: 'hsl(24, 95%, 49%)',
  warm200: 'hsl(225, 35%, 95%)',

  chart: [
    'hsl(212, 92%, 52%)',
    'hsl(187, 72%, 38%)',
    'hsl(262, 70%, 60%)',
    'hsl(322, 60%, 55%)',
    'hsl(232, 16%, 52%)',
  ],

  ...PHYSICAL,

  actions: {
    organize: BRAND_ACCENT.DEFAULT,
    edit: lightInfo.DEFAULT,
    destructive: lightDanger.DEFAULT,
    onAction: '#FFFFFF',
  },
  statusIcon: {
    success: lightSuccess.DEFAULT,
    warning: lightWarning.DEFAULT,
    info: lightInfo.DEFAULT,
    purple: 'hsl(262, 70%, 60%)',
    cyan: 'hsl(187, 72%, 38%)',
  },
};

// ── 暗色：对应 web/src/index.css `.dark` ──
const darkSuccess: SemanticFamily = {
  DEFAULT: 'hsl(134, 70%, 45%)',
  foreground: 'hsl(0, 0%, 100%)',
  subtle: 'hsl(140, 45%, 14%)',
  ink: 'hsl(142, 62%, 68%)',
};
const darkWarning: SemanticFamily = {
  DEFAULT: 'hsl(26, 100%, 60%)',
  foreground: 'hsl(0, 0%, 10%)',
  subtle: 'hsl(28, 55%, 15%)',
  ink: 'hsl(34, 95%, 70%)',
};
const darkDanger: SemanticFamily = {
  DEFAULT: 'hsl(358, 90%, 65%)',
  foreground: 'hsl(0, 0%, 100%)',
  subtle: 'hsl(358, 45%, 16%)',
  ink: 'hsl(358, 92%, 78%)',
};
const darkInfo: SemanticFamily = {
  DEFAULT: 'hsl(213, 94%, 66%)',
  foreground: 'hsl(0, 0%, 10%)',
  subtle: 'hsl(214, 55%, 17%)',
  ink: 'hsl(213, 94%, 76%)',
};

export const darkColors: ThemeColors = {
  background: 'hsl(227, 30%, 8%)',
  foreground: 'hsl(0, 0%, 82%)',
  card: 'hsl(227, 25%, 11%)',
  cardForeground: 'hsl(0, 0%, 82%)',
  popover: 'hsl(227, 25%, 14%)',
  popoverForeground: 'hsl(0, 0%, 82%)',
  primary: 'hsl(227, 89%, 68%)',
  primaryForeground: 'hsl(0, 0%, 100%)',
  secondary: 'hsl(227, 25%, 16%)',
  secondaryForeground: 'hsl(0, 0%, 82%)',
  muted: 'hsl(227, 18%, 18%)',
  mutedForeground: 'hsl(0, 0%, 60%)',
  accent: 'hsl(228, 50%, 22%)',
  accentForeground: 'hsl(225, 100%, 87%)',
  destructive: 'hsl(358, 90%, 65%)',
  destructiveForeground: 'hsl(0, 0%, 100%)',
  border: 'hsl(227, 18%, 18%)',
  borderStrong: 'hsl(227, 18%, 26%)',
  input: 'hsl(227, 18%, 22%)',
  ring: 'hsl(220, 9%, 65%)',

  successFamily: darkSuccess,
  warningFamily: darkWarning,
  dangerFamily: darkDanger,
  infoFamily: darkInfo,
  success: darkSuccess.DEFAULT,
  warning: darkWarning.DEFAULT,
  danger: darkDanger.DEFAULT,
  info: darkInfo.DEFAULT,
  successBg: darkSuccess.subtle,
  errorBg: darkDanger.subtle,

  brand: BRAND,
  brandAccent: BRAND_ACCENT,

  link: 'hsl(227, 89%, 68%)',
  userBubble: 'hsl(24, 28%, 18%)',
  codeBlockBg: 'hsl(227, 22%, 13%)',
  interrupted: 'hsl(24, 95%, 60%)',
  warm200: 'hsl(227, 18%, 18%)',

  chart: [
    'hsl(212, 92%, 64%)',
    'hsl(187, 65%, 50%)',
    'hsl(262, 75%, 70%)',
    'hsl(322, 65%, 66%)',
    'hsl(232, 18%, 62%)',
  ],

  ...PHYSICAL,

  actions: {
    organize: BRAND_ACCENT.DEFAULT,
    edit: darkInfo.DEFAULT,
    destructive: darkDanger.DEFAULT,
    onAction: '#FFFFFF',
  },
  statusIcon: {
    success: darkSuccess.DEFAULT,
    warning: darkWarning.DEFAULT,
    info: darkInfo.DEFAULT,
    purple: 'hsl(262, 75%, 70%)',
    cyan: 'hsl(187, 65%, 50%)',
  },
};

// 向后兼容：未迁移的文件继续 import { colors }
export const colors = lightColors;
