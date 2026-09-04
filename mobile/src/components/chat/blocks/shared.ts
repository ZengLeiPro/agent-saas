/**
 * chat/blocks 跨块共用的常量与样式。
 * 内容自 MessageItem.tsx 原样搬迁，取值未做任何调整。
 */
import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import {
  Archive,
  BookOpen,
  File,
  FileAudio,
  FileCode,
  FileText,
  Image as ImageIcon,
  Presentation,
  Table,
  Video,
  type LucideIcon,
} from 'lucide-react-native';
import type { FileTypeCategory } from '@agent/shared';
import { spacing, radius, typography } from '../../../theme';
import type { ThemeColors } from '../../../theme';

export const CATEGORY_ICON: Record<FileTypeCategory, LucideIcon> = {
  pdf: BookOpen,
  word: FileText,
  ppt: Presentation,
  excel: Table,
  code: FileCode,
  image: ImageIcon,
  video: Video,
  audio: FileAudio,
  text: FileText,
  archive: Archive,
  default: File,
};

export function useMessageStyles(colors: ThemeColors, typo: typeof typography) {
  return useMemo(
    () =>
      StyleSheet.create({
        userBubbleContainer: {
          marginBottom: 8,
        },
        userMenuWrapper: {
          alignSelf: 'flex-end',
        },
        userBubble: {
          backgroundColor: colors.userBubble,
          borderRadius: radius.md,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          shadowColor: colors.shadow,
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.05,
          shadowRadius: 2,
          elevation: 1,
        },
        failedBubble: {
          opacity: 0.6,
        },
        userText: {
          ...typo.body,
          color: colors.foreground,
        },
        attachmentChips: {
          flexDirection: 'row' as const,
          flexWrap: 'wrap' as const,
          gap: 4,
        },
        attachmentChip: {
          flexDirection: 'row' as const,
          alignItems: 'center' as const,
          gap: 3,
          backgroundColor: colors.secondary,
          borderRadius: 4,
          paddingHorizontal: 6,
          paddingVertical: 2,
        },
        attachmentChipText: {
          ...typo.caption,
          color: colors.mutedForeground,
          maxWidth: 160,
        },
        retryButton: {
          marginTop: spacing.xs,
        },
        retryText: {
          ...typo.caption,
          color: colors.primary,
        },
        pendingText: {
          ...typo.caption,
          color: colors.mutedForeground,
          marginTop: 2,
        },
        assistantBubble: {
          maxWidth: '100%',
        },
        /** 气泡底部动作区（反馈 / 申诉）：右对齐、无内容时高度自然为 0 */
        messageActions: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: spacing.sm,
        },
        cursor: {
          width: 8,
          height: 16,
          backgroundColor: colors.primary,
          borderRadius: 2,
          opacity: 0.6,
          marginTop: 2,
        },
        toolRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingVertical: 6,
          marginVertical: 2,
        },
        toolLabel: {
          ...typo.body,
          color: colors.mutedForeground,
          flexShrink: 1,
        },
        codePreview: {
          ...typo.mono,
          fontSize: Math.round(typo.mono.fontSize! * (14 / 13)),
          lineHeight: Math.round(typo.mono.lineHeight! * (20 / 18)),
          color: colors.mutedForeground,
          backgroundColor: colors.codeBlockBg,
          borderRadius: radius.md,
          padding: 12,
          marginTop: 4,
          maxHeight: 256,
          overflow: 'hidden',
        },
        codePreviewScrollable: {
          backgroundColor: colors.codeBlockBg,
          borderRadius: radius.md,
          marginTop: 4,
          maxHeight: 256,
        },
        codePreviewText: {
          ...typo.mono,
          fontSize: Math.round(typo.mono.fontSize! * (14 / 13)),
          lineHeight: Math.round(typo.mono.lineHeight! * (20 / 18)),
          color: colors.mutedForeground,
          padding: 12,
        },
        permissionBlock: {
          paddingVertical: spacing.xs,
        },
        permissionTitle: {
          ...typo.subtitle,
          color: colors.foreground,
          marginBottom: spacing.sm,
        },
        permissionButtons: {
          flexDirection: 'row',
          gap: spacing.sm,
          marginTop: spacing.md,
        },
        permButton: {
          flex: 1,
          minHeight: 44,
          justifyContent: 'center',
          paddingVertical: spacing.sm,
          borderRadius: radius.md,
          alignItems: 'center',
        },
        denyButton: {
          backgroundColor: colors.secondary,
        },
        allowButton: {
          backgroundColor: colors.primary,
        },
        denyText: {
          ...typo.body,
          color: colors.foreground,
          fontWeight: '600',
        },
        allowText: {
          ...typo.body,
          color: colors.primaryForeground,
          fontWeight: '600',
        },
        statusBadge: {
          ...typo.caption,
          marginTop: spacing.sm,
          paddingHorizontal: spacing.sm,
          paddingVertical: 2,
          borderRadius: radius.sm,
          alignSelf: 'flex-start',
          overflow: 'hidden',
        },
        allowedBadge: {
          backgroundColor: colors.successBg,
          color: colors.success,
        },
        deniedBadge: {
          backgroundColor: colors.errorBg,
          color: colors.destructive,
        },
        askUserBlock: {
          paddingVertical: spacing.xs,
        },
        questionContainer: {
          marginBottom: spacing.sm,
        },
        questionHeader: {
          ...typo.subtitle,
          color: colors.foreground,
          marginBottom: spacing.sm,
        },
        optionButton: {
          minHeight: 44,
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius.md,
          padding: spacing.sm,
          marginBottom: spacing.xs,
        },
        optionSelected: {
          borderColor: colors.primary,
          backgroundColor: colors.accent,
        },
        optionLabel: {
          ...typo.body,
          color: colors.foreground,
        },
        optionDesc: {
          ...typo.caption,
          color: colors.mutedForeground,
          marginTop: 2,
        },
        submitButton: {
          minHeight: 44,
          justifyContent: 'center',
          backgroundColor: colors.primary,
          borderRadius: radius.md,
          paddingVertical: spacing.sm,
          alignItems: 'center',
          marginTop: spacing.sm,
        },
        submitText: {
          ...typo.body,
          color: colors.primaryForeground,
          fontWeight: '600',
        },
        subagentBlock: {
          paddingVertical: 4,
        },
        subagentText: {
          ...typo.body,
          color: colors.mutedForeground,
        },
        fileCard: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          backgroundColor: colors.muted,
          borderRadius: 12,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm + 2,
          marginVertical: 4,
        },
        fileIconBadge: {
          width: 40,
          height: 40,
          borderRadius: 8,
          alignItems: 'center' as const,
          justifyContent: 'center' as const,
        },
        fileCardInfo: {
          flex: 1,
          minWidth: 0,
        },
        fileName: {
          ...typo.body,
          color: colors.foreground,
          fontWeight: '500',
        },
        fileSize: {
          ...typo.caption,
          color: colors.mutedForeground,
          marginTop: 2,
        },
        imageGrid: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 8,
          marginTop: 4,
        },
        thumbnailImage: {
          width: 200,
          height: 150,
          borderRadius: radius.md,
          backgroundColor: colors.codeBlockBg,
        },
        voiceBlock: {
          backgroundColor: colors.secondary,
          borderRadius: radius.md,
          padding: spacing.sm,
        },
        voiceText: {
          ...typo.bodySmall,
          color: colors.mutedForeground,
        },
        activityGroup: {},
        activityHeaderRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingVertical: 6,
        },
        activitySummaryText: {
          ...typo.body,
          color: colors.mutedForeground,
          flexShrink: 1,
        },
        activityCount: {
          ...typo.body,
          color: colors.mutedForeground,
          opacity: 0.6,
        },
        activityContent: {
          marginLeft: 20,
          borderLeftWidth: 1,
          borderLeftColor: colors.border,
          paddingLeft: 8,
          paddingTop: 4,
          gap: 2,
        },
      }),
    [colors, typo],
  );
}

/** useMessageStyles 的返回类型，供块组件把 styles 当作 props 传递。 */
export type MessageStyles = ReturnType<typeof useMessageStyles>;
