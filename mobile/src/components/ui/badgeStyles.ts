/**
 * Badge 的「变体 / 尺寸 → token」纯映射层。
 *
 * 与 Web `web/src/components/ui/badge.tsx` 语义对齐：
 * 结构档（default / secondary / outline）走 shadcn 结构色；
 * 语义四族（success / warning / danger / info）一律「subtle 底 + ink 文字」的浅底深字，
 * 因为徽章大量出现在列表行内，实心底会喧宾夺主。
 */
import type { TextStyle } from 'react-native';
import { radius, spacing, fontScale, fontWeight, type ThemeColors } from '../../theme';

export type BadgeVariant =
  'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'danger' | 'info';

export type BadgeSize = 'sm' | 'md';

export interface BadgeVariantTokens {
  backgroundColor?: string;
  foreground: string;
  borderColor?: string;
  borderWidth: number;
}

export function resolveBadgeVariant(
  variant: BadgeVariant,
  colors: ThemeColors,
): BadgeVariantTokens {
  switch (variant) {
    case 'default':
      return {
        backgroundColor: colors.primary,
        foreground: colors.primaryForeground,
        borderWidth: 0,
      };
    case 'secondary':
      return {
        backgroundColor: colors.secondary,
        foreground: colors.secondaryForeground,
        borderWidth: 0,
      };
    case 'outline':
      return {
        foreground: colors.foreground,
        borderColor: colors.border,
        borderWidth: 1,
      };
    case 'success':
      return {
        backgroundColor: colors.successFamily.subtle,
        foreground: colors.successFamily.ink,
        borderWidth: 0,
      };
    case 'warning':
      return {
        backgroundColor: colors.warningFamily.subtle,
        foreground: colors.warningFamily.ink,
        borderWidth: 0,
      };
    case 'danger':
      return {
        backgroundColor: colors.dangerFamily.subtle,
        foreground: colors.dangerFamily.ink,
        borderWidth: 0,
      };
    case 'info':
      return {
        backgroundColor: colors.infoFamily.subtle,
        foreground: colors.infoFamily.ink,
        borderWidth: 0,
      };
  }
}

export interface BadgeSizeTokens {
  paddingHorizontal: number;
  paddingVertical: number;
  borderRadius: number;
  gap: number;
  iconSize: number;
  text: TextStyle;
}

export function resolveBadgeSize(size: BadgeSize): BadgeSizeTokens {
  if (size === 'sm') {
    return {
      paddingHorizontal: spacing.sm,
      paddingVertical: 1,
      borderRadius: radius.full,
      gap: spacing.xs,
      iconSize: 12,
      text: { ...fontScale.xs2, fontWeight: fontWeight.semibold },
    };
  }
  return {
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    borderRadius: radius.full,
    gap: spacing.xs,
    iconSize: 14,
    text: { ...fontScale.xs, fontWeight: fontWeight.semibold },
  };
}
