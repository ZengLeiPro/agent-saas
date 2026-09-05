export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
} as const;

/**
 * 圆角 —— 对齐 Web `--radius: 0.5rem`：lg=8 / md=6 / sm=4；
 * xl / 2xl 对应 Web `rounded-xl` / `rounded-2xl`。
 */
export const radius = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  '2xl': 16,
  full: 9999,
} as const;

/**
 * 阴影 —— Web 只有一个自定义 `shadow-brand`（brand-600 @ 28%）；
 * 其余卡片靠 hairline 边框而非阴影分层。
 */
export const shadows = {
  brand: {
    shadowColor: '#2E56E1',
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 14 },
    elevation: 8,
  },
  card: {
    shadowColor: '#000000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
} as const;
