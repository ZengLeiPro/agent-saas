/**
 * 助手文本块：Markdown 渲染、[FILE] marker 解析与内联文件卡片、长按菜单。
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Share,
  Alert,
} from 'react-native';
import { Download } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Markdown from 'react-native-markdown-display';
import type { MessageItem } from '@agent/shared';
import { authFetch, formatFileSize, getFileTypeVisual, getPreviewFileType } from '@agent/shared';
import { DropdownMenu, type DropdownSection } from '../../overlays/DropdownMenu';
import { fileCacheService } from '../../../services/fileCacheService';
import { cjkMarkdownIt } from '../../../lib/markdownIt';
import { hapticLight } from '../../../lib/haptics';
import { useColors, spacing, useChatTypography } from '../../../theme';
import type { ThemeColors } from '../../../theme';
import { ImageLightbox } from '../ImageLightbox';
import { TextSelectModal } from '../TextSelectModal';
import { createMarkdownStyles } from '../markdownStyles';
import { createMarkdownRules } from '../markdownRules';
import { CATEGORY_ICON, useMessageStyles } from './shared';

// --- Text Message (Markdown) ---
// --- FILE marker parsing for inline rendering ---

const FILE_MARKER_RE_INLINE = /\[FILE\](\{.*?\})\[\/FILE\]/g;
// Partial match at end of streaming text (incomplete marker)
const FILE_MARKER_PARTIAL_RE = /\[FILE\](?:\{[^}]*)?$/;

type TextSegment =
  | { type: 'text'; content: string }
  | {
      type: 'file';
      filePath: string;
      fileName: string;
      fileType: string;
      fileSize: number;
      owner?: string;
    };

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
    } catch {
      /* skip malformed */
    }
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

function InlineFileCard({
  segment,
  onPreviewMd,
  colors,
  styles: s,
}: {
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
    authFetch(`/api/file/download?path=${encodeURIComponent(segment.filePath)}${ownerParam}`, {
      method: 'HEAD',
    })
      .then((res) => {
        if (cancelled) return;
        const cl = res.headers.get('content-length');
        if (cl) setResolvedSize(Number(cl));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [segment.filePath, segment.fileSize, ownerParam]);

  // Mobile only previews inert Markdown workspace files. HTML is fail-closed to Artifact delivery.
  const previewKind = getPreviewFileType(segment.fileName);
  const isPreviewable = previewKind === 'md';
  const isRetiredHtml = previewKind === 'html';
  const fileVisual = getFileTypeVisual(segment.fileName);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const { openOrShareFile } = await import('../../../utils/openOrShareFile');
      const uri = await fileCacheService.getOrDownload(
        segment.filePath,
        0,
        segment.fileSize || 0,
        segment.owner,
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
      Alert.alert(
        '旧预览已停用',
        'Mobile V1 不打开 workspace HTML。正式交付请使用 Artifact viewer。',
      );
      return;
    }
    if (isPreviewable && onPreviewMd) {
      onPreviewMd(segment.filePath);
      return;
    }
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
        {React.createElement(CATEGORY_ICON[fileVisual.category], {
          size: 20,
          color: colors.primaryForeground /* token: 近似 纯白 */,
          strokeWidth: 2,
        })}
      </View>
      <View style={s.fileCardInfo}>
        <Text style={s.fileName} numberOfLines={1}>
          {segment.fileName}
        </Text>
        {resolvedSize > 0 && <Text style={s.fileSize}>{formatFileSize(resolvedSize)}</Text>}
      </View>
      {downloading ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : isPreviewable && onPreviewMd ? (
        <TouchableOpacity
          hitSlop={8}
          onPress={(e) => {
            e.stopPropagation();
            void handleDownload();
          }}
        >
          <Download size={20} color={colors.mutedForeground} strokeWidth={2} />
        </TouchableOpacity>
      ) : (
        <Download size={20} color={colors.mutedForeground} strokeWidth={2} />
      )}
    </TouchableOpacity>
  );
}

export function TextMessage({
  message,
  onPreviewMd,
  onTtsPlay,
}: {
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

  const rules = useMemo(
    () =>
      createMarkdownRules({
        onPreviewMd,
        onImagePress: (uri) => setLightboxUri(uri),
        colors,
        owner: message.owner,
        typo,
      }),
    [onPreviewMd, colors, message.owner, typo],
  );

  // Parse segments: text + inline file cards
  const segments = useMemo(
    () => parseTextSegments(message.content, message.owner),
    [message.content, message.owner],
  );
  const hasFileMarkers = segments.some((s) => s.type === 'file');

  // Plain text for clipboard/share (strip markers)
  const plainText = useMemo(
    () => (hasFileMarkers ? stripFileMarkers(message.content) : message.content),
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

  const assistMenuSections = useMemo<DropdownSection[]>(
    () => [
      {
        id: 's1',
        actions: [
          { id: 'copy', label: '复制' },
          { id: 'select', label: '选择文本' },
          { id: 'share', label: '分享' },
          ...(onTtsPlay ? [{ id: 'tts', label: '朗读' }] : []),
        ],
      },
    ],
    [onTtsPlay],
  );

  const handleAssistMenuSelect = useCallback(
    (actionId: string) => {
      if (actionId === 'copy') void Clipboard.setStringAsync(plainText);
      else if (actionId === 'select') setTextSelectVisible(true);
      else if (actionId === 'share') void Share.share({ message: plainText });
      else if (actionId === 'tts' && onTtsPlay) onTtsPlay(message.id, plainText);
    },
    [plainText, message.id, onTtsPlay],
  );

  const longPressGesture = useMemo(
    () =>
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
                <Markdown key={i} markdownit={cjkMarkdownIt} style={mdStyles} rules={rules}>
                  {seg.content}
                </Markdown>
              ) : (
                <InlineFileCard
                  key={i}
                  segment={seg}
                  onPreviewMd={onPreviewMd}
                  colors={colors}
                  styles={styles}
                />
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
        <TextSelectModal
          visible={textSelectVisible}
          onClose={() => setTextSelectVisible(false)}
          content={plainText}
        />
      </>
    );
  }

  return (
    <>
      <GestureDetector gesture={longPressGesture}>
        <View style={styles.assistantBubble}>
          {finalOutputDivider}
          <Markdown markdownit={cjkMarkdownIt} style={mdStyles} rules={rules}>
            {message.content}
          </Markdown>
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
      <TextSelectModal
        visible={textSelectVisible}
        onClose={() => setTextSelectVisible(false)}
        content={plainText}
      />
    </>
  );
}
