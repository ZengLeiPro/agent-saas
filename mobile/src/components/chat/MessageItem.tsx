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
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { DropdownMenu, type DropdownSection } from '../overlays/DropdownMenu';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { AskUserAnswers, MessageItem, RenderItem, ActivityGroup } from '@agent/shared';
import { truncateContent, formatJson, formatFileSize, authFetch, parseToolResult, getPreviewFileType, getToolDisplayLabel, getToolDisplayInfo, getFileTypeVisual } from '@agent/shared';
import type { FileTypeCategory } from '@agent/shared';
import { fileCacheService } from '../../services/fileCacheService';
import Markdown from 'react-native-markdown-display';
import { useColors, spacing, typography, radius, useChatTypography } from '../../theme';
import type { ThemeColors } from '../../theme';
import { MessageErrorBoundary } from '../ErrorBoundary';
import { ImageLightbox } from './ImageLightbox';
import { TextSelectModal } from './TextSelectModal';
import { createMarkdownStyles } from './markdownStyles';
import { createMarkdownRules } from './markdownRules';
import { hapticLight } from '../../lib/haptics';

const CATEGORY_IONICON: Record<FileTypeCategory, React.ComponentProps<typeof Ionicons>['name']> = {
  pdf: 'reader-outline', word: 'document-text-outline', ppt: 'easel-outline',
  excel: 'grid-outline', code: 'code-slash-outline', image: 'image-outline',
  video: 'videocam-outline', text: 'document-text-outline', archive: 'archive-outline',
  default: 'document-outline',
};

const USER_VOICE_MARKER = '🎙 ';

function formatUserVoiceText(text: string): string {
  return `${USER_VOICE_MARKER}${text}`;
}

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
}: MessageItemViewProps) {
  // Skip fade animation for initial batch to avoid blocking JS thread
  const fadeAnim = useRef(new Animated.Value(skipAnimation ? 1 : 0)).current;
  useEffect(() => {
    if (skipAnimation) return;
    const anim = Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  let content: React.ReactNode;

  if (item.type === 'activity_group') {
    content = <ActivityGroupView group={item} isLast={isLast} />;
  } else {
    switch (item.type) {
      case 'user':
        content = <UserMessage message={item} onRetry={onRetryMessage} onFork={onForkMessage} isFirstUser={isFirstUser} isLoading={isLoading} />;
        break;
      case 'text':
        content = <TextMessage message={item} onPreviewMd={onPreviewMd} onTtsPlay={onTtsPlay} />;
        break;
      case 'thinking':
        content = <ThinkingBlock message={item} />;
        break;
      case 'tool_use':
        content = <ToolUseBlock message={item} />;
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
  const displayText = message.isVoiceTranscript ? formatUserVoiceText(messageText) : messageText;

  return (
    <View style={styles.userBubbleContainer}>
      <Pressable
        onLongPress={handleLongPress}
        style={styles.userMenuWrapper}
      >
        <View style={[styles.userBubble, message.status === 'failed' && styles.failedBubble]}>
          {displayText ? (
            <Text style={styles.userText}>{displayText}</Text>
          ) : null}
          {message.attachments && message.attachments.length > 0 && (
            <View style={[styles.attachmentChips, displayText ? { marginTop: 6 } : undefined]}>
              {message.attachments.map((att, i) => (
                <View key={i} style={styles.attachmentChip}>
                  <Ionicons name={att.isImage ? 'image-outline' : 'attach'} size={12} color={colors.mutedForeground} />
                  <Text style={styles.attachmentChipText} numberOfLines={1}>{att.name}</Text>
                </View>
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

  // mobile 暂仅预览 md/html；text/code 预览为 web 端能力，移动端这些类型走下载
  const previewKind = getPreviewFileType(segment.fileName);
  const isPreviewable = previewKind === 'md' || previewKind === 'html';
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
    if (isPreviewable && onPreviewMd) { onPreviewMd(segment.filePath); return; }
    await handleDownload();
  }, [isPreviewable, onPreviewMd, segment.filePath, handleDownload]);

  return (
    <TouchableOpacity
      style={s.fileCard}
      onPress={() => void handlePress()}
      activeOpacity={0.7}
      disabled={downloading}
    >
      <View style={[s.fileIconBadge, { backgroundColor: fileVisual.color }]}>
        <Ionicons name={CATEGORY_IONICON[fileVisual.category]} size={20} color="#FFFFFF" />
      </View>
      <View style={s.fileCardInfo}>
        <Text style={s.fileName} numberOfLines={1}>{segment.fileName}</Text>
        {resolvedSize > 0 && <Text style={s.fileSize}>{formatFileSize(resolvedSize)}</Text>}
      </View>
      {downloading ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : isPreviewable && onPreviewMd ? (
        <TouchableOpacity hitSlop={8} onPress={(e) => { e.stopPropagation(); void handleDownload(); }}>
          <Ionicons name="download-outline" size={20} color={colors.mutedForeground} />
        </TouchableOpacity>
      ) : (
        <Ionicons name="download-outline" size={20} color={colors.mutedForeground} />
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
        <Markdown style={mdStyles} rules={rules}>{streamContent}</Markdown>
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
            {segments.map((seg, i) =>
              seg.type === 'text' ? (
                <Markdown key={i} style={mdStyles} rules={rules}>{seg.content}</Markdown>
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
          <Markdown style={mdStyles} rules={rules}>{message.content}</Markdown>
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
      <Pressable onPress={() => setExpanded(!expanded)} style={styles.toolRow}>
        <Ionicons name="bulb-outline" size={16} color={colors.mutedForeground} />
        <Text style={styles.toolLabel}>{message.streaming ? '思考中...' : '已思考'}</Text>
        <Ionicons
          name="chevron-forward"
          size={16}
          color={colors.mutedForeground}
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

// --- Tool Use Block (unified: tool_use + result) ---
function ToolUseBlock({ message }: { message: MessageItem & { type: 'tool_use' } }) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const [expanded, setExpanded] = useState(false);
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);

  const hasResult = message.resultReady === true;
  const hasIssue = message.executionStatus === 'failed';
  const isCancelled = message.executionStatus === 'cancelled';

  // 延迟解析结果中的图片
  const parsed = useMemo(
    () => (expanded && hasResult) ? parseToolResult(message.result || "") : null,
    [expanded, hasResult, message.result],
  );
  const hasImages = parsed !== null && parsed.images.length > 0;

  const displayInfo = useMemo(
    () => getToolDisplayInfo(message.toolName, message.toolInput),
    [message.toolName, message.toolInput],
  );

  const icon = message.streaming || message.executionStatus === 'running'
    ? <Ionicons name="build-outline" size={16} color={colors.mutedForeground} />
    : hasIssue
      ? <Ionicons name="alert-circle-outline" size={16} color={colors.warning} />
      : isCancelled
        ? <Ionicons name="close-circle-outline" size={16} color={colors.mutedForeground} />
    : hasResult
      ? <Ionicons name="checkmark-circle-outline" size={16} color={colors.mutedForeground} />
      : <ActivityIndicator size={16} color={colors.primary} />;

  return (
    <View>
      <Pressable onPress={() => setExpanded(!expanded)} style={styles.toolRow}>
        {icon}
        {displayInfo.detail ? (
          <View style={{ flexDirection: 'row', flexShrink: 1, minWidth: 0, alignItems: 'baseline' }}>
            <Text style={[styles.toolLabel, { flexShrink: 0 }]}>
              {displayInfo.name}:{' '}
            </Text>
            <Text
              style={[styles.toolLabel, { maxWidth: 384, minWidth: 0 }]}
              numberOfLines={1}
              ellipsizeMode={displayInfo.detailTruncate === 'start' ? 'head' : 'tail'}
            >
              {displayInfo.detail}
            </Text>
            {message.streaming && (
              <Text style={[styles.toolLabel, { flexShrink: 0 }]}>...</Text>
            )}
          </View>
        ) : (
          <Text style={styles.toolLabel} numberOfLines={1}>
            {displayInfo.name}{message.streaming ? '...' : ''}
          </Text>
        )}
        {hasIssue && <Text style={{ color: colors.warning, fontSize: 11 }}>有异常</Text>}
        <Ionicons
          name="chevron-forward"
          size={16}
          color={colors.mutedForeground}
          style={expanded ? { transform: [{ rotate: '90deg' }] } : undefined}
        />
      </Pressable>
      {expanded && (
        <View>
          <ScrollView style={styles.codePreviewScrollable} nestedScrollEnabled>
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
          </ScrollView>
          {hasResult && hasImages && (
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
      <Pressable onPress={() => setExpanded(!expanded)} style={styles.toolRow}>
        <Ionicons name="checkmark-circle-outline" size={16} color={colors.mutedForeground} />
        <Text style={styles.toolLabel} numberOfLines={1}>Result: {message.toolName}</Text>
        <Ionicons
          name="chevron-forward"
          size={16}
          color={colors.mutedForeground}
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
function PermissionBlock({ message, onResponse }: {
  message: MessageItem & { type: 'permission_request' };
  onResponse?: (interactionId: string, allow: boolean) => Promise<void>;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const mdStyles = useMemo(() => createMarkdownStyles(colors, typo), [colors, typo]);

  return (
    <View style={styles.permissionBlock}>
      <Text style={styles.permissionTitle}>{message.toolName}</Text>
      <Markdown style={mdStyles}>{message.toolInput}</Markdown>
      {message.status === 'pending' && onResponse && (
        <View style={styles.permissionButtons}>
          <TouchableOpacity
            style={[styles.permButton, styles.denyButton]}
            onPress={() => onResponse(message.interactionId, false)}
          >
            <Text style={styles.denyText}>拒绝</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.permButton, styles.allowButton]}
            onPress={() => onResponse(message.interactionId, true)}
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
function AskUserBlock({ message, onResponse }: {
  message: MessageItem & { type: 'ask_user' };
  onResponse?: (interactionId: string, answers: AskUserAnswers) => Promise<void>;
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
  const isPending = message.status === 'pending';

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
              const iconName = q.multiSelect
                ? (isSelected ? 'checkbox' : 'square-outline')
                : (isSelected ? 'radio-button-on' : 'radio-button-off');
              return (
                <TouchableOpacity
                  key={oi}
                  style={[
                    styles.optionButton,
                    { flexDirection: 'row', alignItems: 'center', gap: 8 },
                    isSelected && styles.optionSelected,
                  ]}
                  onPress={() => isPending && handleOptionSelect(q, opt.label)}
                  disabled={!isPending}
                >
                  <Ionicons name={iconName} size={18} color={isSelected ? colors.primary : colors.mutedForeground} />
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
              const customIconName = q.multiSelect
                ? (isCustomSelected ? 'checkbox' : 'square-outline')
                : (isCustomSelected ? 'radio-button-on' : 'radio-button-off');
              return (
                <>
                  <TouchableOpacity
                    style={[
                      styles.optionButton,
                      { flexDirection: 'row', alignItems: 'center', gap: 8 },
                      isCustomSelected && styles.optionSelected,
                    ]}
                    onPress={() => isPending && handleOptionSelect(q, '__custom__')}
                    disabled={!isPending}
                  >
                    <Ionicons name={customIconName} size={18} color={isCustomSelected ? colors.primary : colors.mutedForeground} />
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
                      placeholder="Enter your answer..."
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
          style={[styles.submitButton, !hasAnySelection && { opacity: 0.5 }]}
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
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);

  const hasIssue = message.status === 'failed' || message.status === 'timeout';
  const iconName = message.status === 'running'
    ? 'time-outline'
    : hasIssue
      ? 'alert-circle-outline'
      : message.status === 'cancelled'
        ? 'close-circle-outline'
        : 'checkmark-outline';
  const statusText = message.status === 'running'
    ? `子任务: ${message.agentType}`
    : message.status === 'failed'
      ? `子任务未完成: ${message.agentType}`
      : message.status === 'timeout'
        ? `子任务超时: ${message.agentType}`
        : message.status === 'cancelled'
          ? `子任务已取消: ${message.agentType}`
          : `子任务: ${message.agentType}`;

  return (
    <View style={[styles.subagentBlock, { flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
      <Ionicons name={iconName} size={14} color={hasIssue ? colors.warning : colors.mutedForeground} />
      <Text style={[styles.subagentText, hasIssue && { color: colors.warning }]}>{statusText}</Text>
    </View>
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

  // mobile 暂仅预览 md/html；text/code 预览为 web 端能力，移动端这些类型走下载
  const previewKind = getPreviewFileType(message.fileName);
  const isPreviewable = previewKind === 'md' || previewKind === 'html';
  const fileVisual = getFileTypeVisual(message.fileName);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      // Artifact 走签名 URL 直下：/api/artifacts/:id/read-url 拿 15 min URL,
      // 交给 expo-sharing 打开分享面板（原生下载/保存/发送）。
      if (artifactId) {
        const res = await authFetch(`/api/artifacts/${encodeURIComponent(artifactId)}/read-url`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json() as { url?: string };
        if (!body.url) throw new Error('signed url missing');
        const { openOrShareUrl } = await import('../../utils/openOrShareFile');
        await openOrShareUrl(body.url, message.fileName);
        return;
      }
      const { openOrShareFile } = await import('../../utils/openOrShareFile');
      const uri = await fileCacheService.getOrDownload(
        message.filePath, 0, message.fileSize || 0, message.owner,
      );
      await openOrShareFile(uri);
    } catch (err: any) {
      console.error('File download/share failed:', err, 'filePath:', message.filePath);
      Alert.alert('下载失败', `${err?.message || String(err)}\n\npath: ${message.filePath}`);
    } finally {
      setDownloading(false);
    }
  }, [artifactId, message.filePath, message.fileName, message.fileSize, message.owner]);

  const handlePress = useCallback(async () => {
    // Artifact 卡片不支持工作区路径预览，直接触发下载/分享
    if (!artifactId && isPreviewable && onPreviewMd) {
      onPreviewMd(message.filePath);
      return;
    }
    await handleDownload();
  }, [artifactId, isPreviewable, onPreviewMd, message.filePath, handleDownload]);

  return (
    <TouchableOpacity
      style={styles.fileCard}
      onPress={() => void handlePress()}
      activeOpacity={0.7}
      disabled={downloading}
    >
      <View style={[styles.fileIconBadge, { backgroundColor: fileVisual.color }]}>
        <Ionicons name={CATEGORY_IONICON[fileVisual.category]} size={20} color="#FFFFFF" />
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
          <Ionicons name="download-outline" size={20} color={colors.mutedForeground} />
        </TouchableOpacity>
      ) : (
        <Ionicons name="download-outline" size={20} color={colors.mutedForeground} />
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
    <View style={styles.voiceBlock}>
      <Text style={styles.voiceText}>🔊 语音消息 ({message.voiceMarkers.length} 段)</Text>
    </View>
  );
}

// --- User Voice Block ---
function UserVoiceBlock({ message }: { message: MessageItem & { type: 'user-voice' } }) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const fallbackText = message.status === 'uploading' ? '上传中...'
    : message.status === 'transcribing' ? '识别中...'
    : message.status === 'failed' ? message.failedReason || '发送失败'
    : '';
  const displayText = formatUserVoiceText(message.transcribedText || fallbackText);

  return (
    <View style={styles.userBubbleContainer}>
      <View style={[styles.userBubble, message.status === 'failed' && styles.failedBubble]}>
        <Text style={styles.userText}>{displayText}</Text>
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
    default: return { text: '', ellipsizeMode: 'tail' };
  }
}

function renderActivityItem(item: MessageItem) {
  switch (item.type) {
    case 'thinking': return <ThinkingBlock key={item.id} message={item as MessageItem & { type: 'thinking' }} />;
    case 'tool_use': return <ToolUseBlock key={item.id} message={item as MessageItem & { type: 'tool_use' }} />;
    case 'tool_result': return <ToolResultBlock key={item.id} message={item as MessageItem & { type: 'tool_result' }} />;
    case 'subagent': return <SubagentBlock key={item.id} message={item as MessageItem & { type: 'subagent' }} />;
    default: return null;
  }
}

function ActivityGroupView({ group }: { group: ActivityGroup; isLast?: boolean }) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const [expanded, setExpanded] = useState(false);

  // Single item group: render directly without wrapper
  if (group.items.length === 1) {
    return <>{renderActivityItem(group.items[0])}</>;
  }

  // Multi-item group
  const lastItem = group.items[group.items.length - 1];
  const issueCount = group.isActive ? 0 : group.items.filter(item => (
    (item.type === 'tool_use' && item.executionStatus === 'failed')
    || (item.type === 'subagent' && (item.status === 'failed' || item.status === 'timeout'))
  )).length;
  const summary = issueCount > 0
    ? { text: `执行结束 · ${issueCount} 个步骤未成功`, ellipsizeMode: 'tail' as const }
    : getSummary(lastItem);

  return (
    <View style={styles.activityGroup}>
      <TouchableOpacity onPress={() => setExpanded(!expanded)} style={styles.activityHeaderRow} activeOpacity={0.7}>
        {group.isActive
          ? <ActivityIndicator size={16} color={colors.primary} />
          : issueCount > 0
            ? <Ionicons name="alert-circle-outline" size={16} color={colors.warning} />
            : <Ionicons name="checkmark-circle-outline" size={16} color={colors.mutedForeground} style={{ opacity: 0.6 }} />
        }
        <Text style={[styles.activitySummaryText, { maxWidth: 384 }, issueCount > 0 && { color: colors.warning }]} numberOfLines={1} ellipsizeMode={summary.ellipsizeMode}>{summary.text}</Text>
        <Text style={styles.activityCount}>({group.items.length})</Text>
        <Ionicons
          name="chevron-forward"
          size={16}
          color={colors.mutedForeground}
          style={expanded ? { transform: [{ rotate: '90deg' }] } : undefined}
        />
      </TouchableOpacity>
      {expanded && (
        <View style={styles.activityContent}>
          {group.items.map(item => renderActivityItem(item))}
        </View>
      )}
    </View>
  );
}
