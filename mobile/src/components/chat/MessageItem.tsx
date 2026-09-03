import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Pressable,
  Animated,
  ActivityIndicator,
  Image,
  Share,
  Alert,
  ScrollView,
  TextInput,
} from 'react-native';
import {
  Archive,
  BookOpen,
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleSlash2,
  Clock,
  Download,
  File,
  FileAudio,
  FileCode,
  FileText,
  Image as ImageIcon,
  Lightbulb,
  Mic,
  Paperclip,
  Play,
  Pause,
  Presentation,
  Square,
  SquareCheck,
  Table,
  TriangleAlert,
  Video,
  Volume2,
  Wrench,
  type LucideIcon,
} from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { DropdownMenu, type DropdownSection } from '../overlays/DropdownMenu';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type {
  ActivityGroup,
  AskUserAnswers,
  BusinessStepEventItem,
  MessageItem,
  PresentationBlock,
  RawPresentationGate,
  RenderItem,
  SharedPresentation,
} from '@agent/shared';
import {
  authFetch,
  formatFileSize,
  formatJson,
  formatTokenCount,
  getFileTypeVisual,
  getPreviewFileType,
  getToolDisplayInfo,
  getToolDisplayLabel,
  parseToolResult,
  selectBusinessStepPresentation,
  selectErrorPresentation,
  selectRenderModel,
  selectToolPresentation,
  truncateContent,
} from '@agent/shared';
import type { FileTypeCategory } from '@agent/shared';
import { fileCacheService } from '../../services/fileCacheService';
import Markdown from 'react-native-markdown-display';
import { useVoicePlayer } from '../../hooks/useVoicePlayer';
import { cjkMarkdownIt } from '../../lib/markdownIt';
import { useColors, spacing, typography, radius, useChatTypography } from '../../theme';
import type { ThemeColors } from '../../theme';
import { MessageErrorBoundary } from '../ErrorBoundary';
import { ImageLightbox } from './ImageLightbox';
import { TextSelectModal } from './TextSelectModal';
import { createMarkdownStyles } from './markdownStyles';
import { fetchMobileArtifactGrant, mobileArtifactWarning, selectMobileArtifactViewer } from '../../lib/artifactViewAdapter';
import { createMarkdownRules } from './markdownRules';
import { hapticLight } from '../../lib/haptics';
import { AgentActivityShell, type AgentActivityState } from './AgentActivityShell';

const CATEGORY_ICON: Record<FileTypeCategory, LucideIcon> = {
  pdf: BookOpen, word: FileText, ppt: Presentation,
  excel: Table, code: FileCode, image: ImageIcon,
  video: Video, audio: FileAudio, text: FileText, archive: Archive,
  default: File,
};

function useMessageStyles(colors: ThemeColors, typo: typeof typography) {
  return useMemo(() => StyleSheet.create({
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
  }), [colors, typo]);
}

interface MessageItemViewProps {
  item: RenderItem;
  isLast?: boolean;
  skipAnimation?: boolean;
  onPermissionResponse?: (interactionId: string, allow: boolean) => Promise<void>;
  onAskUserResponse?: (interactionId: string, answers: AskUserAnswers) => Promise<void>;
  onRetryMessage?: (message: MessageItem) => void;
  onForkMessage?: (message: MessageItem) => void;
  isFirstUser?: boolean;
  isLoading?: boolean;
  onPreviewMd?: (filePath: string) => void;
  onTtsPlay?: (key: string, text: string) => void;
  presentationGate?: RawPresentationGate;
}

export const MessageItemView = React.memo(function MessageItemView({
  item,
  isLast,
  skipAnimation,
  onPermissionResponse,
  onAskUserResponse,
  onRetryMessage,
  onForkMessage,
  isFirstUser,
  isLoading,
  onPreviewMd,
  onTtsPlay,
  presentationGate,
}: MessageItemViewProps) {
  // Skip fade animation for initial batch to avoid blocking JS thread
  const fadeAnim = useRef(new Animated.Value(skipAnimation ? 1 : 0)).current;
  useEffect(() => {
    if (skipAnimation) return;
    const anim = Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, []);

  let content: React.ReactNode;

  if (item.type === 'activity_group') {
    content = <ActivityGroupView group={item} isLast={isLast} gate={presentationGate} onRetry={onRetryMessage} />;
  } else {
    switch (item.type) {
      case 'user':
        content = <UserMessage message={item} onRetry={onRetryMessage} onFork={onForkMessage} isFirstUser={isFirstUser} isLoading={isLoading} />;
        break;
      case 'text':
        content = item.moderation && item.moderation.outcome !== 'allowed'
          ? <ModerationMessage message={item} />
          : <TextMessage message={item} onPreviewMd={onPreviewMd} onTtsPlay={onTtsPlay} />;
        break;
      case 'thinking':
        content = <ThinkingBlock message={item} />;
        break;
      case 'tool_use':
        content = <ToolUseBlock message={item} gate={presentationGate} onRecovery={onRetryMessage ? () => onRetryMessage(item) : undefined} />;
        break;
      case 'tool_result':
        content = <ToolResultBlock message={item} />;
        break;
      case 'permission_request':
        content = <PermissionBlock message={item} onResponse={onPermissionResponse} />;
        break;
      case 'ask_user':
        content = <AskUserBlock message={item} onResponse={onAskUserResponse} />;
        break;
      case 'subagent':
        content = <SubagentBlock message={item} />;
        break;
      case 'file_download':
        content = <FileDownloadCard message={item} onPreviewMd={onPreviewMd} />;
        break;
      case 'voice':
        content = <VoiceBlock message={item} />;
        break;
      case 'user-voice':
        content = <UserVoiceBlock message={item} />;
        break;
      case 'business_step':
        content = <BusinessStepCard event={item} gate={presentationGate} />;
        break;
      case 'runtime_status':
      case 'system_event':
      case 'system-error':
        content = <SystemTimelineMessage message={item} gate={presentationGate} onRetry={onRetryMessage} />;
        break;
      default:
        content = null;
    }
  }

  return (
    <MessageErrorBoundary>
      <Animated.View style={{ opacity: fadeAnim }}>
        {content}
      </Animated.View>
    </MessageErrorBoundary>
  );
});

function SystemTimelineMessage({ message, gate, onRetry }: {
  message: Extract<MessageItem, { type: 'runtime_status' | 'system_event' | 'system-error' }>;
  gate?: RawPresentationGate;
  onRetry?: (message: MessageItem) => void;
}) {
  const colors = useColors();
  if (message.type === 'system-error') {
    const item = selectRenderModel({ messages: [message] }).items[0];
    const presentation = selectErrorPresentation(item, gate);
    const recovery = presentation.recoveryAction;
    return (
      <View
        accessibilityRole={presentation.tone === 'danger' ? 'alert' : 'summary'}
        accessibilityLabel={[presentation.title, presentation.statusLabel, presentation.summary, recovery?.label].filter(Boolean).join('，')}
        accessibilityLiveRegion={presentation.tone === 'danger' ? 'assertive' : 'polite'}
        style={{ paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderLeftWidth: 2, borderLeftColor: presentation.tone === 'danger' ? colors.destructive : colors.border }}
      >
        <Text style={{ ...typography.bodySmall, fontWeight: '600', color: presentation.tone === 'danger' ? colors.destructive : colors.foreground }}>{presentation.title}</Text>
        <Text style={{ ...typography.bodySmall, color: colors.mutedForeground }}>{presentation.summary ?? presentation.statusLabel}</Text>
        {presentation.showRaw && presentation.summary !== message.content ? (
          <Text style={{ ...typography.caption, color: colors.mutedForeground }}>{message.content}</Text>
        ) : null}
        {recovery?.kind === 'retry' && onRetry ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${presentation.title}，${recovery.label}`}
            onPress={() => onRetry(message)}
            style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: spacing.sm }}
          >
            <Text style={{ ...typography.bodySmall, fontWeight: '600', color: colors.foreground }}>{recovery.label}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  const text = message.type === 'runtime_status'
    ? (message.content ?? message.status)
    : `${message.title}：${message.content}`;
  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel={`运行状态：${text}`}
      accessibilityLiveRegion="polite"
      style={{ paddingVertical: spacing.xs, paddingHorizontal: spacing.sm, borderLeftWidth: 2, borderLeftColor: colors.border }}
    >
      <Text style={{ ...typography.bodySmall, color: colors.mutedForeground }}>{text}</Text>
    </View>
  );
}

function ModerationMessage({ message }: { message: MessageItem & { type: 'text' } }) {
  const colors = useColors();
  const outcome = message.moderation?.outcome ?? 'flagged';
  const text = outcome === 'blocked' ? '内容已被安全策略拦截' : '内容已标记，等待审核';
  return (
    <View accessibilityRole={outcome === 'blocked' ? 'alert' : 'summary'} accessibilityLabel={text} accessibilityLiveRegion={outcome === 'blocked' ? 'assertive' : 'polite'} style={{ paddingVertical: spacing.xs, paddingHorizontal: spacing.sm }}>
      <Text style={{ ...typography.bodySmall, color: outcome === 'blocked' ? colors.destructive : colors.mutedForeground }}>{text}</Text>
    </View>
  );
}

// --- User Message ---
function UserMessage({ message, onRetry, onFork, isFirstUser, isLoading }: {
  message: MessageItem & { type: 'user' };
  onRetry?: (message: MessageItem) => void;
  onFork?: (message: MessageItem) => void;
  isFirstUser?: boolean;
  isLoading?: boolean;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);

  const showFork = !!onFork && !isFirstUser && !isLoading && message.id.startsWith('line-');

  const [menuVisible, setMenuVisible] = useState(false);
  const [anchorTop, setAnchorTop] = useState(0);
  const [attachmentPreviewUri, setAttachmentPreviewUri] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const openAttachment = useCallback(async (attachment: NonNullable<typeof message.attachments>[number]) => {
    if (!attachment.attachmentId) return;
    setAttachmentError(null);
    try {
      const uri = await fileCacheService.getOrDownloadAttachment(attachment.attachmentId, attachment.name);
      if (attachment.isImage) setAttachmentPreviewUri(uri);
      else await Share.share({ url: uri, title: attachment.name });
    } catch {
      setAttachmentError('附件已过期、删除或无权访问');
    }
  }, [message.attachments]);

  const sections = useMemo<DropdownSection[]>(() => [{
    id: 's1',
    actions: [
      { id: 'copy', label: '复制' },
      { id: 'share', label: '分享' },
      ...(showFork ? [{ id: 'fork', label: '从此编辑' }] : []),
    ],
  }], [showFork]);

  const handleAction = useCallback((actionId: string) => {
    switch (actionId) {
      case 'copy':
        void Clipboard.setStringAsync(message.content);
        break;
      case 'share':
        void Share.share({ message: message.content });
        break;
      case 'fork':
        onFork?.(message);
        break;
    }
  }, [message.content, onFork, message]);

  const handleLongPress = useCallback((e: import('react-native').GestureResponderEvent) => {
    hapticLight();
    setAnchorTop(e.nativeEvent.pageY);
    setMenuVisible(true);
  }, []);

  const messageText = message.displayContent ?? message.content;
  const displayText = messageText;

  return (
    <View style={styles.userBubbleContainer}>
      <Pressable
        onLongPress={handleLongPress}
        style={styles.userMenuWrapper}
      >
        <View style={[styles.userBubble, message.status === 'failed' && styles.failedBubble]}>
          {displayText ? (
            message.isVoiceTranscript ? (
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 4 }}>
                <Mic size={14} color={colors.foreground} strokeWidth={2} style={{ marginTop: 3 }} />
                <Text style={[styles.userText, { flexShrink: 1 }]}>{displayText}</Text>
              </View>
            ) : (
              <Text style={styles.userText}>{displayText}</Text>
            )
          ) : null}
          {message.attachments && message.attachments.length > 0 && (
            <View style={[styles.attachmentChips, displayText ? { marginTop: 6 } : undefined]}>
              {message.attachments.map((att, i) => (
                <Pressable
                  key={att.attachmentId ?? i}
                  style={styles.attachmentChip}
                  onPress={att.attachmentId ? () => void openAttachment(att) : undefined}
                  accessibilityRole={att.attachmentId ? 'button' : 'text'}
                  accessibilityLabel={`${att.isImage ? '查看图片' : '下载附件'}：${att.name}${att.size !== undefined ? `，${formatFileSize(att.size)}` : ''}`}
                >
                  {att.isImage
                    ? <ImageIcon size={12} color={colors.mutedForeground} strokeWidth={2} />
                    : <Paperclip size={12} color={colors.mutedForeground} strokeWidth={2} />}
                  <View style={{ maxWidth: 180 }}>
                    <Text style={styles.attachmentChipText} numberOfLines={1}>{att.name}</Text>
                    {(att.mimeType || att.size !== undefined) && (
                      <Text style={[styles.attachmentChipText, { fontSize: 10 }]} numberOfLines={1}>
                        {[att.mimeType?.split('/').at(-1), att.size !== undefined ? formatFileSize(att.size) : undefined].filter(Boolean).join(' · ')}
                      </Text>
                    )}
                  </View>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </Pressable>
      <DropdownMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        sections={sections}
        onSelect={handleAction}
        anchorTop={anchorTop}
        align="right"
      />
      {message.status === 'failed' && onRetry && (
        <TouchableOpacity onPress={() => onRetry(message)} style={styles.retryButton}>
          <Text style={styles.retryText}>重试</Text>
        </TouchableOpacity>
      )}
      {message.status === 'pending' && (
        <Text style={styles.pendingText}>发送中...</Text>
      )}
      {attachmentError && <Text accessibilityRole="alert" style={styles.retryText}>{attachmentError}</Text>}
      {attachmentPreviewUri && (
        <ImageLightbox visible uri={attachmentPreviewUri} onClose={() => setAttachmentPreviewUri(null)} />
      )}
    </View>
  );
}

// --- Text Message (Markdown) ---
// --- FILE marker parsing for inline rendering ---

const FILE_MARKER_RE_INLINE = /\[FILE\](\{.*?\})\[\/FILE\]/g;
// Partial match at end of streaming text (incomplete marker)
const FILE_MARKER_PARTIAL_RE = /\[FILE\](?:\{[^}]*)?$/;

type TextSegment = { type: 'text'; content: string } | { type: 'file'; filePath: string; fileName: string; fileType: string; fileSize: number; owner?: string };

function parseTextSegments(content: string, owner?: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;
  for (const match of content.matchAll(new RegExp(FILE_MARKER_RE_INLINE.source, 'g'))) {
    const before = content.slice(lastIndex, match.index);
    if (before.trim()) segments.push({ type: 'text', content: before });
    try {
      const payload = JSON.parse(match[1]);
      const filePath: string = payload.filePath || payload.path;
      if (filePath) {
        segments.push({
          type: 'file',
          filePath,
          fileName: payload.fileName || filePath.split('/').pop() || 'file',
          fileType: payload.fileType || '',
          fileSize: payload.fileSize ?? 0,
          ...(owner ? { owner } : {}),
        });
      }
    } catch { /* skip malformed */ }
    lastIndex = match.index! + match[0].length;
  }
  const tail = content.slice(lastIndex);
  if (tail.trim()) segments.push({ type: 'text', content: tail });
  return segments;
}

function stripFileMarkers(content: string): string {
  return content
    .replace(new RegExp(FILE_MARKER_RE_INLINE.source, 'g'), '')
    .replace(FILE_MARKER_PARTIAL_RE, '');
}

function InlineFileCard({ segment, onPreviewMd, colors, styles: s }: {
  segment: TextSegment & { type: 'file' };
  onPreviewMd?: (filePath: string) => void;
  colors: ThemeColors;
  styles: ReturnType<typeof useMessageStyles>;
}) {
  const [resolvedSize, setResolvedSize] = useState(segment.fileSize);
  const [downloading, setDownloading] = useState(false);

  const ownerParam = segment.owner ? `&owner=${encodeURIComponent(segment.owner)}` : '';

  useEffect(() => {
    if (segment.fileSize > 0) return;
    let cancelled = false;
    authFetch(`/api/file/download?path=${encodeURIComponent(segment.filePath)}${ownerParam}`, { method: 'HEAD' })
      .then(res => {
        if (cancelled) return;
        const cl = res.headers.get('content-length');
        if (cl) setResolvedSize(Number(cl));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [segment.filePath, segment.fileSize, ownerParam]);

  // Mobile only previews inert Markdown workspace files. HTML is fail-closed to Artifact delivery.
  const previewKind = getPreviewFileType(segment.fileName);
  const isPreviewable = previewKind === 'md';
  const isRetiredHtml = previewKind === 'html';
  const fileVisual = getFileTypeVisual(segment.fileName);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const { openOrShareFile } = await import('../../utils/openOrShareFile');
      const uri = await fileCacheService.getOrDownload(
        segment.filePath, 0, segment.fileSize || 0, segment.owner,
      );
      await openOrShareFile(uri);
    } catch (err: any) {
      Alert.alert('下载失败', `${err?.message || String(err)}\n\npath: ${segment.filePath}`);
    } finally {
      setDownloading(false);
    }
  }, [segment.filePath, segment.fileName, segment.fileSize, segment.owner]);

  const handlePress = useCallback(async () => {
    if (isRetiredHtml) {
      Alert.alert('旧预览已停用', 'Mobile V1 不打开 workspace HTML。正式交付请使用 Artifact viewer。');
      return;
    }
    if (isPreviewable && onPreviewMd) { onPreviewMd(segment.filePath); return; }
    await handleDownload();
  }, [isRetiredHtml, isPreviewable, onPreviewMd, segment.filePath, handleDownload]);

  return (
    <TouchableOpacity
      style={s.fileCard}
      onPress={() => void handlePress()}
      activeOpacity={0.7}
      disabled={downloading}
    >
      <View style={[s.fileIconBadge, { backgroundColor: fileVisual.color }]}>
        {React.createElement(CATEGORY_ICON[fileVisual.category], { size: 20, color: '#FFFFFF', strokeWidth: 2 })}
      </View>
      <View style={s.fileCardInfo}>
        <Text style={s.fileName} numberOfLines={1}>{segment.fileName}</Text>
        {resolvedSize > 0 && <Text style={s.fileSize}>{formatFileSize(resolvedSize)}</Text>}
      </View>
      {downloading ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : isPreviewable && onPreviewMd ? (
        <TouchableOpacity hitSlop={8} onPress={(e) => { e.stopPropagation(); void handleDownload(); }}>
          <Download size={20} color={colors.mutedForeground} strokeWidth={2} />
        </TouchableOpacity>
      ) : (
        <Download size={20} color={colors.mutedForeground} strokeWidth={2} />
      )}
    </TouchableOpacity>
  );
}

function TextMessage({ message, onPreviewMd, onTtsPlay }: {
  message: MessageItem & { type: 'text' };
  onPreviewMd?: (filePath: string) => void;
  onTtsPlay?: (key: string, text: string) => void;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);
  const [textSelectVisible, setTextSelectVisible] = useState(false);

  const mdStyles = useMemo(() => createMarkdownStyles(colors, typo), [colors, typo]);

  const rules = useMemo(() => createMarkdownRules({
    onPreviewMd,
    onImagePress: (uri) => setLightboxUri(uri),
    colors,
    owner: message.owner,
    typo,
  }), [onPreviewMd, colors, message.owner, typo]);

  // Parse segments: text + inline file cards
  const segments = useMemo(
    () => parseTextSegments(message.content, message.owner),
    [message.content, message.owner],
  );
  const hasFileMarkers = segments.some(s => s.type === 'file');

  // Plain text for clipboard/share (strip markers)
  const plainText = useMemo(
    () => hasFileMarkers ? stripFileMarkers(message.content) : message.content,
    [message.content, hasFileMarkers],
  );

  const [assistMenuVisible, setAssistMenuVisible] = useState(false);
  const [assistAnchorTop, setAssistAnchorTop] = useState(0);
  const finalOutputDivider = message.finalOutput ? (
    <View
      accessible={false}
      testID="final-output-divider"
      style={{
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.border,
        marginBottom: spacing.sm,
      }}
    />
  ) : null;

  const assistMenuSections = useMemo<DropdownSection[]>(() => [{
    id: 's1',
    actions: [
      { id: 'copy', label: '复制' },
      { id: 'select', label: '选择文本' },
      { id: 'share', label: '分享' },
      ...(onTtsPlay ? [{ id: 'tts', label: '朗读' }] : []),
    ],
  }], [onTtsPlay]);

  const handleAssistMenuSelect = useCallback((actionId: string) => {
    if (actionId === 'copy') void Clipboard.setStringAsync(plainText);
    else if (actionId === 'select') setTextSelectVisible(true);
    else if (actionId === 'share') void Share.share({ message: plainText });
    else if (actionId === 'tts' && onTtsPlay) onTtsPlay(message.id, plainText);
  }, [plainText, message.id, onTtsPlay]);

  const longPressGesture = useMemo(() =>
    Gesture.LongPress()
      .minDuration(500)
      .runOnJS(true)
      .onStart((e) => {
        hapticLight();
        setAssistAnchorTop(e.absoluteY);
        setAssistMenuVisible(true);
      }),
    [],
  );

  // Streaming: strip markers from display but don't render inline cards (marker may be incomplete)
  if (message.streaming) {
    const streamContent = hasFileMarkers ? stripFileMarkers(message.content) : message.content;
    return (
      <View style={styles.assistantBubble}>
        {finalOutputDivider}
        <Markdown markdownit={cjkMarkdownIt} style={mdStyles} rules={rules}>
          {streamContent}
        </Markdown>
        <View style={styles.cursor} />
        {lightboxUri && (
          <ImageLightbox visible uri={lightboxUri} onClose={() => setLightboxUri(null)} />
        )}
      </View>
    );
  }

  // Non-streaming with file markers: render interleaved text + file cards
  if (hasFileMarkers) {
    return (
      <>
        <GestureDetector gesture={longPressGesture}>
          <View style={styles.assistantBubble}>
            {finalOutputDivider}
            {segments.map((seg, i) =>
              seg.type === 'text' ? (
                <Markdown key={i} markdownit={cjkMarkdownIt} style={mdStyles} rules={rules}>{seg.content}</Markdown>
              ) : (
                <InlineFileCard key={i} segment={seg} onPreviewMd={onPreviewMd} colors={colors} styles={styles} />
              ),
            )}
            {lightboxUri && (
              <ImageLightbox visible uri={lightboxUri} onClose={() => setLightboxUri(null)} />
            )}
          </View>
        </GestureDetector>
        <DropdownMenu
          visible={assistMenuVisible}
          onClose={() => setAssistMenuVisible(false)}
          sections={assistMenuSections}
          onSelect={handleAssistMenuSelect}
          anchorTop={assistAnchorTop}
        />
        <TextSelectModal visible={textSelectVisible} onClose={() => setTextSelectVisible(false)} content={plainText} />
      </>
    );
  }

  return (
    <>
      <GestureDetector gesture={longPressGesture}>
        <View style={styles.assistantBubble}>
          {finalOutputDivider}
          <Markdown markdownit={cjkMarkdownIt} style={mdStyles} rules={rules}>{message.content}</Markdown>
          {lightboxUri && (
            <ImageLightbox visible uri={lightboxUri} onClose={() => setLightboxUri(null)} />
          )}
        </View>
      </GestureDetector>
      <DropdownMenu
        visible={assistMenuVisible}
        onClose={() => setAssistMenuVisible(false)}
        sections={assistMenuSections}
        onSelect={handleAssistMenuSelect}
        anchorTop={assistAnchorTop}
      />
      <TextSelectModal visible={textSelectVisible} onClose={() => setTextSelectVisible(false)} content={plainText} />
    </>
  );
}

// --- Thinking Block ---
function ThinkingBlock({ message }: { message: MessageItem & { type: 'thinking' } }) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const [expanded, setExpanded] = useState(false);
  if (!message.content && !message.streaming) return null;

  return (
    <View>
      <Pressable onPress={() => setExpanded(!expanded)} style={styles.toolRow} accessibilityRole="button" accessibilityLabel="展开或折叠详情" accessibilityState={{ expanded }}>
        <Lightbulb size={16} color={colors.mutedForeground} strokeWidth={2} />
        <Text style={styles.toolLabel}>{message.streaming ? '思考中...' : '已思考'}</Text>
        <ChevronRight
          size={16}
          color={colors.mutedForeground}
          strokeWidth={2}
          style={expanded ? { transform: [{ rotate: '90deg' }] } : undefined}
        />
      </Pressable>
      {expanded && (
        <ScrollView style={styles.codePreviewScrollable} nestedScrollEnabled>
          <Text style={styles.codePreviewText}>{message.content}</Text>
        </ScrollView>
      )}
    </View>
  );
}

function detailLineText(line: SharedPresentation['detail'][number]): string {
  if (typeof line === 'string') return line;
  if ('k' in line) return `${line.k}：${line.v}`;
  if ('no' in line) return `${line.no}. ${line.text}`;
  if ('indent' in line) return line.text;
  if ('section' in line) return line.section;
  if ('warn' in line) return line.warn;
  if ('insight' in line) return `${line.label ? `${line.label}：` : ''}${line.insight}`;
  if ('risk' in line) return `${line.text}${line.action ? `；${line.action}` : ''}`;
  if ('verdict' in line) return `${line.text}${line.note ? `；${line.note}` : ''}`;
  if ('quote' in line) return `${line.quote}${line.source ? ` — ${line.source}` : ''}`;
  if ('original' in line) return `${line.original}${line.translation ? `；${line.translation}` : ''}`;
  return line.fields.map((field) => `${field.k}：${field.v}`).join('；');
}

function displayBlockLines(block: PresentationBlock): string[] {
  if (block.kind === 'callout') return [block.title, ...block.body, ...(block.detail?.map(detailLineText) ?? [])].filter((value): value is string => !!value);
  if (block.kind === 'records') return [
    block.title,
    ...block.items.map((item) => [
      item.label,
      item.value,
      item.baseline,
      item.current,
      item.delta,
      item.note,
    ].filter(Boolean).join(' · ')),
    block.footer,
  ].filter((value): value is string => !!value);
  return [block.title, ...(block.body ?? [])];
}

function CanonicalPresentationBody({ presentation }: { presentation: SharedPresentation }) {
  const colors = useColors();
  const lines = [
    ...presentation.detail.map(detailLineText),
    ...presentation.display.flatMap(displayBlockLines),
    ...presentation.evidence.map((item) => `依据：${item}`),
  ];
  return (
    <View style={{ gap: spacing.xs, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs }}>
      {presentation.summary ? <Text style={{ ...typography.bodySmall, color: colors.foreground }}>{presentation.summary}</Text> : null}
      {lines.map((line, index) => <Text key={`${index}-${line}`} style={{ ...typography.caption, color: colors.mutedForeground }}>{line}</Text>)}
      {presentation.receipt ? <Text style={{ ...typography.caption, color: colors.mutedForeground }}>{presentation.receipt.system} · {presentation.receipt.id}</Text> : null}
    </View>
  );
}

function BusinessStepCard({ event, gate }: { event: BusinessStepEventItem; gate?: RawPresentationGate }) {
  const colors = useColors();
  const presentation = useMemo(() => selectBusinessStepPresentation(event, gate), [event, gate]);
  return (
    <View
      accessibilityRole={presentation.tone === 'danger' ? 'alert' : 'summary'}
      accessibilityLabel={[presentation.title, presentation.statusLabel, presentation.summary].filter(Boolean).join('，')}
      accessibilityLiveRegion={presentation.tone === 'danger' ? 'assertive' : 'polite'}
      style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm, gap: spacing.xs }}
    >
      <Text style={{ ...typography.bodySmall, fontWeight: '600', color: colors.foreground }}>{presentation.title}</Text>
      <Text style={{ ...typography.caption, color: presentation.tone === 'danger' ? colors.destructive : colors.mutedForeground }}>{presentation.statusLabel}</Text>
      <CanonicalPresentationBody presentation={presentation} />
    </View>
  );
}

// --- Tool Use Block (canonical summary + debug-authorized raw payload) ---
function ToolUseBlock({ message, gate, onRecovery }: { message: MessageItem & { type: 'tool_use' }; gate?: RawPresentationGate; onRecovery?: () => void }) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const [expanded, setExpanded] = useState(false);
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);

  const hasResult = message.resultReady === true;
  const item = useMemo(() => selectRenderModel({ messages: [message] }).items[0], [message]);
  const canonical = useMemo(() => selectToolPresentation(item, gate), [gate, item]);
  const hasIssue = canonical.status === 'failed';
  const isCancelled = canonical.status === 'cancelled';

  // 延迟解析结果中的图片
  const parsed = useMemo(
    () => (expanded && hasResult && canonical.showRaw) ? parseToolResult(message.result || "") : null,
    [canonical.showRaw, expanded, hasResult, message.result],
  );
  const hasImages = parsed !== null && parsed.images.length > 0;

  const icon = canonical.busy
    ? <ActivityIndicator size={16} color={colors.primary} />
    : hasIssue
      ? <CircleAlert size={16} color={colors.warning} strokeWidth={2} />
      : isCancelled
        ? <CircleSlash2 size={16} color={colors.mutedForeground} strokeWidth={2} />
        : <CircleCheck size={16} color={colors.mutedForeground} strokeWidth={2} />;

  return (
    <View>
      <Pressable
        onPress={() => setExpanded(!expanded)}
        style={[styles.toolRow, { minHeight: 44 }]}
        accessibilityRole="button"
        accessibilityLabel={[canonical.title, canonical.statusLabel, canonical.summary, expanded ? '收起详情' : '展开详情'].filter(Boolean).join('，')}
        accessibilityState={{ expanded, busy: canonical.busy }}
      >
        <View accessible={false}>{icon}</View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.toolLabel} numberOfLines={1}>{canonical.title}{canonical.busy ? '...' : ''}</Text>
          {canonical.summary ? <Text style={{ ...typography.caption, color: colors.mutedForeground }} numberOfLines={1}>{canonical.summary}</Text> : null}
        </View>
        <Text style={{ color: hasIssue ? colors.warning : colors.mutedForeground, fontSize: 11 }}>{canonical.statusLabel}</Text>
        <View accessible={false}>
          <ChevronRight
            size={16}
            color={colors.mutedForeground}
            strokeWidth={2}
            style={expanded ? { transform: [{ rotate: '90deg' }] } : undefined}
          />
        </View>
      </Pressable>
      {canonical.recoveryAction && onRecovery ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${canonical.title}，${canonical.recoveryAction.label}`}
          onPress={onRecovery}
          style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: spacing.sm }}
        >
          <Text style={{ ...typography.bodySmall, fontWeight: '600', color: colors.foreground }}>{canonical.recoveryAction.label}</Text>
        </Pressable>
      ) : null}
      {expanded && (
        <View>
          <CanonicalPresentationBody presentation={canonical} />
          {canonical.showRaw ? <ScrollView style={styles.codePreviewScrollable} nestedScrollEnabled>
            <Text style={styles.codePreviewText}>
              {formatJson(message.toolInput)}
            </Text>
            {hasResult && !hasImages && (
              <>
                <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, marginTop: 8, paddingTop: 8 }}>
                  <Text style={{ ...styles.codePreviewText, padding: 0, paddingHorizontal: 12, marginBottom: 4 }}>Result:</Text>
                  <Text style={styles.codePreviewText}>{message.result}</Text>
                </View>
              </>
            )}
          </ScrollView> : null}
          {canonical.showRaw && hasResult && hasImages && (
            <>
              <Text style={{ ...typo.caption, fontWeight: '600', color: colors.mutedForeground, marginVertical: 6 }}>Result:</Text>
              <View style={styles.imageGrid}>
                {parsed.images.map((img, i) => {
                  const uri = `data:${img.mimeType};base64,${img.data}`;
                  return (
                    <Pressable key={i} onPress={() => setLightboxUri(uri)}>
                      <Image
                        source={{ uri }}
                        style={styles.thumbnailImage}
                        resizeMode="contain"
                      />
                    </Pressable>
                  );
                })}
              </View>
              {parsed.text ? (
                <ScrollView style={styles.codePreviewScrollable} nestedScrollEnabled>
                  <Text style={styles.codePreviewText}>{parsed.text}</Text>
                </ScrollView>
              ) : null}
              {lightboxUri && (
                <ImageLightbox visible uri={lightboxUri} onClose={() => setLightboxUri(null)} />
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}

// --- Tool Result Block ---
function ToolResultBlock({ message }: { message: MessageItem & { type: 'tool_result' } }) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const [expanded, setExpanded] = useState(false);
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);

  // 延迟解析：仅在展开时才 parse（避免折叠状态下浪费 CPU 解析大 base64）
  const parsed = useMemo(
    () => expanded ? parseToolResult(message.result) : null,
    [expanded, message.result],
  );
  const hasImages = parsed !== null && parsed.images.length > 0;

  return (
    <View>
      <Pressable onPress={() => setExpanded(!expanded)} style={styles.toolRow} accessibilityRole="button" accessibilityLabel="展开或折叠详情" accessibilityState={{ expanded }}>
        <CircleCheck size={16} color={colors.mutedForeground} strokeWidth={2} />
        <Text style={styles.toolLabel} numberOfLines={1}>Result: {message.toolName}</Text>
        <ChevronRight
          size={16}
          color={colors.mutedForeground}
          strokeWidth={2}
          style={expanded ? { transform: [{ rotate: '90deg' }] } : undefined}
        />
      </Pressable>
      {expanded && hasImages && (
        <>
          <View style={styles.imageGrid}>
            {parsed.images.map((img, i) => {
              const uri = `data:${img.mimeType};base64,${img.data}`;
              return (
                <Pressable key={i} onPress={() => setLightboxUri(uri)}>
                  <Image
                    source={{ uri }}
                    style={styles.thumbnailImage}
                    resizeMode="contain"
                  />
                </Pressable>
              );
            })}
          </View>
          {parsed.text ? (
            <ScrollView style={styles.codePreviewScrollable} nestedScrollEnabled>
              <Text style={styles.codePreviewText}>{parsed.text}</Text>
            </ScrollView>
          ) : null}
          {lightboxUri && (
            <ImageLightbox visible uri={lightboxUri} onClose={() => setLightboxUri(null)} />
          )}
        </>
      )}
      {expanded && !hasImages && (
        <ScrollView style={styles.codePreviewScrollable} nestedScrollEnabled>
          <Text style={styles.codePreviewText}>
            {message.result}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

// --- Permission Block ---
export function PermissionBlock({ message, onResponse, disabled = false }: {
  message: MessageItem & { type: 'permission_request' };
  onResponse?: (interactionId: string, allow: boolean) => Promise<void>;
  disabled?: boolean;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const mdStyles = useMemo(() => createMarkdownStyles(colors, typo), [colors, typo]);

  return (
    <View style={styles.permissionBlock}>
      <Text style={styles.permissionTitle}>{message.toolName}</Text>
      <Markdown markdownit={cjkMarkdownIt} style={mdStyles}>{message.toolInput}</Markdown>
      {message.status === 'pending' && (
        <View style={styles.permissionButtons}>
          <TouchableOpacity
            testID="permission-deny-button"
            style={[styles.permButton, styles.denyButton]}
            accessibilityRole="button"
            accessibilityLabel={`拒绝权限请求 ${message.toolName}`}
            disabled={disabled || !onResponse}
            accessibilityState={{ disabled: disabled || !onResponse }}
            onPress={() => onResponse?.(message.interactionId, false)}
          >
            <Text style={styles.denyText}>拒绝</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="permission-allow-button"
            style={[styles.permButton, styles.allowButton]}
            accessibilityRole="button"
            accessibilityLabel={`允许权限请求 ${message.toolName}`}
            disabled={disabled || !onResponse}
            accessibilityState={{ disabled: disabled || !onResponse }}
            onPress={() => onResponse?.(message.interactionId, true)}
          >
            <Text style={styles.allowText}>允许</Text>
          </TouchableOpacity>
        </View>
      )}
      {message.status !== 'pending' && (
        <Text style={[styles.statusBadge, message.status === 'allowed' ? styles.allowedBadge : styles.deniedBadge]}>
          {message.status === 'allowed' ? '已允许' : '已拒绝'}
        </Text>
      )}
    </View>
  );
}

// --- Ask User Block ---
export function AskUserBlock({ message, onResponse, disabled = false }: {
  message: MessageItem & { type: 'ask_user' };
  onResponse?: (interactionId: string, answers: AskUserAnswers) => Promise<void>;
  disabled?: boolean;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const [selections, setSelections] = useState<Record<string, Set<string>>>({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});

  const handleOptionSelect = useCallback((q: { question: string; multiSelect: boolean }, optionLabel: string) => {
    setSelections(prev => {
      const current = new Set(prev[q.question] ?? []);
      if (optionLabel === '__custom__') {
        if (current.has('__custom__')) {
          current.delete('__custom__');
        } else {
          if (!q.multiSelect) current.clear();
          current.add('__custom__');
        }
      } else {
        if (current.has(optionLabel)) {
          current.delete(optionLabel);
        } else {
          if (!q.multiSelect) current.clear();
          current.add(optionLabel);
        }
        current.delete('__custom__');
      }
      return { ...prev, [q.question]: current };
    });
  }, []);

  const handleSubmit = useCallback(() => {
    if (!onResponse) return;
    const answers: AskUserAnswers = {};
    for (const q of message.questions) {
      const selected = selections[q.question];
      if (selected?.has('__custom__')) {
        const labels = Array.from(selected).filter(label => label !== '__custom__');
        const customValue = customInputs[q.question] ?? '';
        answers[q.question] = q.multiSelect ? [...labels, customValue].filter(Boolean) : customValue;
      } else {
        const labels = selected ? Array.from(selected) : [];
        answers[q.question] = q.multiSelect ? labels : (labels[0] ?? '');
      }
    }
    void onResponse(message.interactionId, answers);
  }, [onResponse, message, selections, customInputs]);

  const hasAnySelection = useMemo(
    () => Object.values(selections).some(s => s.size > 0),
    [selections],
  );

  const isAnswered = message.status === 'answered';
  const isPending = message.status === 'pending' && !disabled;

  // Parse answered multi-select values back to Set for highlight
  const answeredSets = useMemo(() => {
    if (!isAnswered || !message.answers) return {} as Record<string, Set<string>>;
    const result: Record<string, Set<string>> = {};
    for (const [k, v] of Object.entries(message.answers)) {
      result[k] = new Set(Array.isArray(v) ? v : (v ? v.split(', ') : []));
    }
    return result;
  }, [isAnswered, message.answers]);

  return (
    <View style={styles.askUserBlock}>
      {message.questions.map((q, qi) => {
        const selectedSet = isPending ? (selections[q.question] ?? new Set()) : (answeredSets[q.question] ?? new Set());
        return (
          <View key={qi} style={styles.questionContainer}>
            <View style={{ marginBottom: spacing.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: q.header && q.question ? 4 : 0 }}>
                <Text style={[styles.questionHeader, { marginBottom: 0, flex: 1 }]}>{q.header || q.question}</Text>
                <Text style={{ ...typo.caption, color: colors.mutedForeground }}>
                  {q.multiSelect ? '多选' : '单选'}
                </Text>
              </View>
              {q.header && q.question ? (
                <Text style={{ ...typo.body, color: colors.foreground }}>{q.question}</Text>
              ) : null}
            </View>
            {q.options.map((opt, oi) => {
              const isSelected = selectedSet.has(opt.label);
              const OptionIcon = q.multiSelect
                ? (isSelected ? SquareCheck : Square)
                : (isSelected ? CircleDot : Circle);
              return (
                <TouchableOpacity
                  key={oi}
                  style={[
                    styles.optionButton,
                    { flexDirection: 'row', alignItems: 'center', gap: 8 },
                    isSelected && styles.optionSelected,
                  ]}
                  accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                  accessibilityLabel={`${q.header || q.question}: ${opt.label}${opt.description ? `, ${opt.description}` : ''}`}
                  accessibilityState={{ checked: isSelected, disabled: !isPending }}
                  onPress={() => isPending && handleOptionSelect(q, opt.label)}
                  disabled={!isPending}
                >
                  <OptionIcon size={18} color={isSelected ? colors.primary : colors.mutedForeground} strokeWidth={2} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.optionLabel}>{opt.label}</Text>
                    {opt.description ? <Text style={styles.optionDesc}>{opt.description}</Text> : null}
                  </View>
                </TouchableOpacity>
              );
            })}
            {(() => {
              const answer = isAnswered ? message.answers?.[q.question] : '';
              const answerText = Array.isArray(answer) ? answer.join(', ') : (answer ?? '');
              const matchesOptions = q.options.some(opt => selectedSet.has(opt.label));
              const isCustomAnswer = isAnswered && !matchesOptions && answerText.length > 0;

              if (!isPending && !isCustomAnswer) return null;

              const isCustomSelected = isPending ? selectedSet.has('__custom__') : true;
              const CustomOptionIcon = q.multiSelect
                ? (isCustomSelected ? SquareCheck : Square)
                : (isCustomSelected ? CircleDot : Circle);
              return (
                <>
                  <TouchableOpacity
                    style={[
                      styles.optionButton,
                      { flexDirection: 'row', alignItems: 'center', gap: 8 },
                      isCustomSelected && styles.optionSelected,
                    ]}
                    accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                    accessibilityLabel={`${q.header || q.question}: 自定义回答`}
                    accessibilityState={{ checked: isCustomSelected, disabled: !isPending }}
                    onPress={() => isPending && handleOptionSelect(q, '__custom__')}
                    disabled={!isPending}
                  >
                    <CustomOptionIcon size={18} color={isCustomSelected ? colors.primary : colors.mutedForeground} strokeWidth={2} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.optionLabel}>Other</Text>
                      <Text style={styles.optionDesc}>{isCustomAnswer ? answerText : '输入自定义回答'}</Text>
                    </View>
                  </TouchableOpacity>
                  {isPending && isCustomSelected && (
                    <TextInput
                      style={{
                        backgroundColor: colors.secondary,
                        borderRadius: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        marginTop: 4,
                        color: colors.foreground,
                        ...typo.body,
                      }}
                      accessibilityLabel={`${q.header || q.question} 自定义回答`}
                      placeholder="请输入回答"
                      placeholderTextColor={colors.mutedForeground}
                      value={customInputs[q.question] ?? ''}
                      onChangeText={(text) => setCustomInputs(prev => ({ ...prev, [q.question]: text }))}
                    />
                  )}
                </>
              );
            })()}
          </View>
        );
      })}
      {isPending && onResponse && (
        <TouchableOpacity
          testID="ask-user-submit"
          style={[styles.submitButton, !hasAnySelection && { opacity: 0.5 }]}
          accessibilityRole="button"
          accessibilityLabel="提交回答"
          onPress={handleSubmit}
          disabled={!hasAnySelection}
        >
          <Text style={styles.submitText}>提交</Text>
        </TouchableOpacity>
      )}
      {isAnswered && (
        <Text style={[styles.statusBadge, styles.allowedBadge]}>已回答</Text>
      )}
    </View>
  );
}

// --- Subagent Block ---
function SubagentBlock({ message }: { message: MessageItem & { type: 'subagent' } }) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const state: AgentActivityState = message.status === 'running'
    ? 'running'
    : message.status === 'completed'
      ? 'completed'
      : message.status === 'cancelled'
        ? 'cancelled'
        : 'failed';
  const meta = [
    message.model,
    typeof message.durationMs === 'number' ? `${(message.durationMs / 1000).toFixed(1)}s` : undefined,
    typeof message.turnCount === 'number' ? `${message.turnCount} 轮` : undefined,
    typeof message.totalTokens === 'number' ? `${formatTokenCount(message.totalTokens)} tokens` : undefined,
  ].filter(Boolean).join(' · ');

  return (
    <AgentActivityShell
      state={state}
      title={`子任务 ${message.agentType}`}
      meta={meta || undefined}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      <View style={{ gap: spacing.xs }}>
        <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
          {[
            message.model ? `模型 ${message.model}` : undefined,
            typeof message.turnCount === 'number' ? `${message.turnCount} 轮` : undefined,
            typeof message.toolUseCount === 'number' ? `${message.toolUseCount} 次工具` : undefined,
          ].filter(Boolean).join(' · ')}
        </Text>
        {message.errorMessage ? (
          <Text style={{ ...typography.caption, color: colors.destructive }}>{message.errorMessage}</Text>
        ) : null}
        {message.resultPreview ? (
          <Text style={{ ...typography.caption, color: colors.foreground }} numberOfLines={6}>
            {message.resultPreview}
          </Text>
        ) : null}
      </View>
    </AgentActivityShell>
  );
}

// --- File Download ---
function FileDownloadCard({ message, onPreviewMd }: {
  message: MessageItem & { type: 'file_download' };
  onPreviewMd?: (filePath: string) => void;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const [resolvedSize, setResolvedSize] = useState(message.fileSize);
  const [downloading, setDownloading] = useState(false);

  const ownerParam = message.owner ? `&owner=${encodeURIComponent(message.owner)}` : '';
  const artifactId = message.artifactId;

  // HEAD 请求懒加载真实文件大小；artifact 卡片跳过（sourcePath 不保证在工作区仍存在）
  useEffect(() => {
    if (message.fileSize > 0) return;
    if (artifactId) return;
    let cancelled = false;
    authFetch(`/api/file/download?path=${encodeURIComponent(message.filePath)}${ownerParam}`, { method: 'HEAD' })
      .then(res => {
        if (cancelled) return;
        const cl = res.headers.get('content-length');
        if (cl) setResolvedSize(Number(cl));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [message.filePath, message.fileSize, ownerParam, artifactId]);

  // Mobile only previews inert Markdown workspace files. HTML is fail-closed to Artifact delivery.
  const previewKind = getPreviewFileType(message.fileName);
  const isPreviewable = previewKind === 'md';
  const isRetiredHtml = previewKind === 'html';
  const fileVisual = getFileTypeVisual(message.fileName);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      // Artifact only accepts artifactId. The server owns MIME+magic policy and returns a
      // short, principal-bound grant. Mobile never executes artifact HTML in a WebView.
      if (artifactId) {
        let grant = await fetchMobileArtifactGrant(artifactId);
        if (selectMobileArtifactViewer(grant) === 'download-only' || grant.descriptor.requiresWarning) {
          const confirmed = await new Promise<boolean>((resolve) => Alert.alert(
            '确认下载此文件？',
            mobileArtifactWarning(grant),
            [
              { text: '取消', style: 'cancel', onPress: () => resolve(false) },
              { text: '仍要下载', style: 'destructive', onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          ));
          if (!confirmed) return;
          grant = await fetchMobileArtifactGrant(artifactId, true);
        }
        const { openOrShareUrl } = await import('../../utils/openOrShareFile');
        await openOrShareUrl(grant.readUrl, grant.descriptor.name);
        return;
      }
      const { openOrShareFile } = await import('../../utils/openOrShareFile');
      const uri = await fileCacheService.getOrDownload(
        message.filePath, 0, message.fileSize || 0, message.owner,
      );
      await openOrShareFile(uri);
    } catch (err: any) {
      // Never emit signed URLs/tokens to console, analytics, crash logs or user-visible errors.
      const messageText = artifactId ? 'Artifact 暂时无法安全打开，请稍后重试' : (err?.message || String(err));
      if (!artifactId) console.error('File download/share failed for legacy workspace file');
      Alert.alert('下载失败', messageText);
    } finally {
      setDownloading(false);
    }
  }, [artifactId, message.filePath, message.fileName, message.fileSize, message.owner]);

  const handlePress = useCallback(async () => {
    // Formal artifacts stay on the M50-02 artifactId/grant path. Legacy workspace HTML fails closed.
    if (!artifactId && isRetiredHtml) {
      Alert.alert('旧预览已停用', 'Mobile V1 不打开 workspace HTML。正式交付请使用 Artifact viewer。');
      return;
    }
    if (!artifactId && isPreviewable && onPreviewMd) {
      onPreviewMd(message.filePath);
      return;
    }
    await handleDownload();
  }, [artifactId, isRetiredHtml, isPreviewable, onPreviewMd, message.filePath, handleDownload]);

  return (
    <TouchableOpacity
      testID={artifactId ? `artifact-${artifactId}` : undefined}
      accessibilityLabel={`${artifactId ? 'Artifact' : '文件'}：${message.fileName}`}
      style={styles.fileCard}
      onPress={() => void handlePress()}
      activeOpacity={0.7}
      disabled={downloading}
    >
      <View style={[styles.fileIconBadge, { backgroundColor: fileVisual.color }]}>
        {React.createElement(CATEGORY_ICON[fileVisual.category], { size: 20, color: '#FFFFFF', strokeWidth: 2 })}
      </View>
      <View style={styles.fileCardInfo}>
        <Text style={styles.fileName} numberOfLines={1}>{message.fileName}</Text>
        {resolvedSize > 0 && (
          <Text style={styles.fileSize}>{formatFileSize(resolvedSize)}</Text>
        )}
      </View>
      {downloading ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : isPreviewable && onPreviewMd ? (
        <TouchableOpacity
          hitSlop={8}
          onPress={(e) => { e.stopPropagation(); void handleDownload(); }}
        >
          <Download size={20} color={colors.mutedForeground} strokeWidth={2} />
        </TouchableOpacity>
      ) : (
        <Download size={20} color={colors.mutedForeground} strokeWidth={2} />
      )}
    </TouchableOpacity>
  );
}

// --- Voice Block ---
function VoiceBlock({ message }: { message: MessageItem & { type: 'voice' } }) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);

  return (
    <View style={[styles.voiceBlock, { flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
      <Volume2 size={14} color={colors.mutedForeground} strokeWidth={2} />
      <Text style={styles.voiceText}>语音消息 ({message.voiceMarkers.length} 段)</Text>
    </View>
  );
}

// --- User Voice Block ---
function UserVoiceBlock({ message }: { message: MessageItem & { type: 'user-voice' } }) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const player = useVoicePlayer();
  const playState = player.getState(message.id);
  const playable = !!message.attachmentId && (message.status === 'ready' || message.status === 'sent');
  const fallbackText = message.status === 'uploading' ? '上传中…'
    : message.status === 'transcribing' ? '转写中…'
    : message.status === 'ready' ? '转写已就绪，请编辑后发送'
    : message.status === 'failed' ? message.failedReason || '语音处理失败'
    : '已发送';
  const displayText = message.transcribedText || fallbackText;
  const durationLabel = `${Math.max(0, Math.round(message.duration))} 秒`;

  return (
    <View style={styles.userBubbleContainer} accessible accessibilityRole="summary" accessibilityLabel={`语音 ${durationLabel}，${fallbackText}`}>
      <View style={[styles.userBubble, message.status === 'failed' && styles.failedBubble]}>
        <Pressable
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 4 }}
          disabled={!playable}
          accessibilityRole={playable ? 'button' : undefined}
          accessibilityLabel={playable ? `播放语音，${durationLabel}` : undefined}
          onPress={() => {
            if (!message.attachmentId) return;
            if (playState === 'idle') player.play(message.id, message.attachmentId);
            else player.togglePause(message.id);
          }}
        >
          {playable ? (playState === 'playing' ? <Pause size={14} color={colors.foreground} /> : <Play size={14} color={colors.foreground} />) : <Mic size={14} color={colors.foreground} />}
          <Text style={[styles.userText, { flexShrink: 1 }]}>{durationLabel} · {displayText}</Text>
        </Pressable>
      </View>
    </View>
  );
}

// --- Activity Group ---
interface SummaryInfo {
  text: string;
  ellipsizeMode: 'head' | 'tail';
}

function getSummary(item: MessageItem): SummaryInfo {
  switch (item.type) {
    case 'thinking': return { text: item.streaming ? '思考中...' : '已思考', ellipsizeMode: 'tail' };
    case 'tool_use': {
      const info = getToolDisplayInfo(item.toolName, item.toolInput);
      const label = info.detail ? `${info.name}: ${info.detail}` : info.name;
      const text = item.streaming ? `${label}...` : label;
      return { text, ellipsizeMode: info.detailTruncate === 'start' ? 'head' : 'tail' };
    }
    case 'tool_result': return { text: `Result: ${item.toolName}`, ellipsizeMode: 'tail' };
    case 'subagent': return { text: item.status === 'running' ? `子任务 ${item.agentType}...` : `子任务 ${item.agentType}`, ellipsizeMode: 'tail' };
    case 'runtime_status': return { text: item.content ?? item.status, ellipsizeMode: 'tail' };
    default: return { text: '', ellipsizeMode: 'tail' };
  }
}

function renderActivityItem(item: MessageItem) {
  switch (item.type) {
    case 'thinking': return <ThinkingBlock key={item.id} message={item as MessageItem & { type: 'thinking' }} />;
    case 'tool_use': return <ToolUseBlock key={item.id} message={item as MessageItem & { type: 'tool_use' }} />;
    case 'tool_result': return <ToolResultBlock key={item.id} message={item as MessageItem & { type: 'tool_result' }} />;
    case 'subagent': return <SubagentBlock key={item.id} message={item as MessageItem & { type: 'subagent' }} />;
    case 'runtime_status': return <SystemTimelineMessage key={item.id} message={item} />;
    default: return null;
  }
}

function ActivityGroupView({ group, gate, onRetry }: { group: ActivityGroup; isLast?: boolean; gate?: RawPresentationGate; onRetry?: (message: MessageItem) => void }) {
  const [expanded, setExpanded] = useState(false);
  const lastItem = group.items[group.items.length - 1];
  const summary = getSummary(lastItem);
  const hasFailure = group.items.some((item) => (
    (item.type === 'tool_use' && item.executionStatus === 'failed')
    || (item.type === 'subagent' && (item.status === 'failed' || item.status === 'timeout'))
  ));
  const state: AgentActivityState = group.isActive ? 'running' : hasFailure ? 'warning' : 'completed';

  return (
    <AgentActivityShell
      state={state}
      title="Agent 活动"
      subtitle={summary.text}
      meta={`${group.items.length} 项`}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      <View style={{ gap: spacing.xs }}>
        {group.items.map(item => item.type === 'tool_use'
          ? <ToolUseBlock key={item.id} message={item} gate={gate} onRecovery={onRetry ? () => onRetry(item) : undefined} />
          : renderActivityItem(item))}
      </View>
    </AgentActivityShell>
  );
}
