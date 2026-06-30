import { StyleSheet } from 'react-native';
import type { ThemeColors } from '../../theme';
import { spacing, radius, typography as defaultTypography } from '../../theme';

export function createMarkdownStyles(colors: ThemeColors, typo = defaultTypography) {
  return StyleSheet.create({
    body: {
      ...typo.body,
      color: colors.foreground,
    },
    paragraph: {
      marginVertical: 10,
    },
    heading1: {
      ...typo.title,
      marginVertical: 12,
    },
    heading2: {
      ...typo.subtitle,
      marginVertical: 12,
    },
    heading3: {
      ...typo.body,
      fontWeight: '600',
      marginVertical: 10,
    },
    code_inline: {
      ...typo.mono,
      backgroundColor: colors.muted,
      paddingHorizontal: 4,
      borderRadius: 3,
    },
    code_block: {
      ...typo.mono,
      backgroundColor: colors.codeBlockBg,
      padding: 12,
      borderRadius: radius.md,
    },
    fence: {
      ...typo.mono,
      backgroundColor: colors.codeBlockBg,
      padding: 12,
      borderRadius: radius.md,
    },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: colors.borderStrong,
      backgroundColor: colors.secondary,
      paddingLeft: spacing.md,
      paddingVertical: spacing.xs,
      marginVertical: 8,
      borderRadius: radius.sm,
    },
    link: {
      color: colors.link,
      textDecorationLine: 'none' as const,
    },
    bullet_list: {
      marginVertical: 10,
    },
    ordered_list: {
      marginVertical: 10,
    },
    list_item: {
      marginVertical: 4,
    },
    hr: {
      backgroundColor: colors.border,
      height: StyleSheet.hairlineWidth,
      marginVertical: 16,
    },
  });
}
