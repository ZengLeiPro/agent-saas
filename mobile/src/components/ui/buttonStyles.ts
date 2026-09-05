/**
 * Button 的「变体 / 尺寸 → token」纯映射层。
 *
 * 组件只负责渲染，所有语义决策集中在这里，便于单测直接断言映射结果，
 * 也保证按钮外观与 Web `web/src/components/ui/button.tsx` 的 variant 语义一一对应：
 *   primary=default(实心品牌蓝) / secondary / outline / ghost / destructive / link。
 */
import type { TextStyle } from 'react-native';
import { radius, spacing, fontScale, fontWeight, type ThemeColors } from '../../theme';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';

export type ButtonSize = 'sm' | 'md' | 'lg';

/** disabled 态整体降透明度（对齐 Web `disabled:opacity-50`） */
export const BUTTON_DISABLED_OPACITY = 0.5;

export interface ButtonVariantTokens {
  /** 省略表示透明底（ghost / link） */
  backgroundColor?: string;
  /** 按下态底色；省略则退化为整体降透明度 */
  pressedBackgroundColor?: string;
  foreground: string;
  borderColor?: string;
  borderWidth: number;
  /** link 变体带下划线 */
  underline: boolean;
}

export function resolveButtonVariant(
  variant: ButtonVariant,
  colors: ThemeColors,
): ButtonVariantTokens {
  switch (variant) {
    case 'primary':
      return {
        backgroundColor: colors.primary,
        pressedBackgroundColor: colors.brand[700],
        foreground: colors.primaryForeground,
        borderWidth: 0,
        underline: false,
      };
    case 'secondary':
      return {
        backgroundColor: colors.secondary,
        pressedBackgroundColor: colors.muted,
        foreground: colors.secondaryForeground,
        borderWidth: 0,
        underline: false,
      };
    case 'outline':
      return {
        backgroundColor: colors.card,
        pressedBackgroundColor: colors.accent,
        foreground: colors.foreground,
        borderColor: colors.input,
        borderWidth: 1,
        underline: false,
      };
    case 'ghost':
      return {
        pressedBackgroundColor: colors.accent,
        foreground: colors.foreground,
        borderWidth: 0,
        underline: false,
      };
    case 'destructive':
      return {
        backgroundColor: colors.destructive,
        pressedBackgroundColor: colors.dangerFamily.ink,
        foreground: colors.destructiveForeground,
        borderWidth: 0,
        underline: false,
      };
    case 'link':
      return {
        foreground: colors.link,
        borderWidth: 0,
        underline: true,
      };
  }
}

export interface ButtonSizeTokens {
  minHeight: number;
  paddingHorizontal: number;
  gap: number;
  borderRadius: number;
  iconSize: number;
  text: TextStyle;
}

/**
 * 高度比 Web 略大：Web 是鼠标目标（32/36/40），移动端需要 ≥44 的可点区域。
 */
export function resolveButtonSize(size: ButtonSize): ButtonSizeTokens {
  switch (size) {
    case 'sm':
      return {
        minHeight: 36,
        paddingHorizontal: spacing.md,
        gap: spacing.xs,
        borderRadius: radius.md,
        iconSize: 14,
        text: { ...fontScale.xs, fontWeight: fontWeight.medium },
      };
    case 'md':
      return {
        minHeight: 44,
        paddingHorizontal: spacing.lg,
        gap: spacing.sm,
        borderRadius: radius.md,
        iconSize: 16,
        text: { ...fontScale.sm, fontWeight: fontWeight.medium },
      };
    case 'lg':
      return {
        minHeight: 52,
        paddingHorizontal: spacing['2xl'],
        gap: spacing.sm,
        borderRadius: radius.lg,
        iconSize: 16,
        text: { ...fontScale.base, fontWeight: fontWeight.semibold },
      };
  }
}

/** link 变体不吃容器 padding / 高度，表现为一段可点文字 */
export function isBareVariant(variant: ButtonVariant): boolean {
  return variant === 'link';
}
