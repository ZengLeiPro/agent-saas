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
import type { MarkerSegment, MessageItem } from '@agent/shared';
import {
  authFetch,
  formatFileSize,
  getFileTypeVisual,
  getPreviewFileType,
  splitByMessageMarkers,
  splitMathSegments,
  stripPartialCiteMarker,
} from '@agent/shared';
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
import { MessageCitationCard } from './CitationCard';
import { GuardrailAppealButton } from './GuardrailAppealButton';
import { MathBlock } from './MathBlock';
import { MessageFeedbackButton } from './MessageFeedback';
import { CATEGORY_ICON, useMessageStyles } from './shared';

// --- Text Message (Markdown) ---
// --- [FILE]/[CITE] 标记切分 ---
// 切分逻辑统一走 shared 的 splitByMessageMarkers（FILE 行为与旧实现逐行为等价，
// CITE 新增文档/Context 两类引用卡）；mobile 不再复制一份正则与 JSON 解析。

/** 流式尾部未闭合的 [FILE] 标记（shared 只负责裁剪半截 [CITE]） */
const FILE_MARKER_PARTIAL_RE = /\[FILE\](?:\{[^}]*)?$/;

type FileSegment = Extract<MarkerSegment, { type: 'file' }>;

/** 流式渲染时抑制半截标记：CITE 交给 shared，FILE 沿用 mobile 既有的尾部裁剪 */
function displaySourceOf(content: string, streaming?: boolean): string {
  if (!streaming) return content;
  return stripPartialCiteMarker(content).replace(FILE_MARKER_PARTIAL_RE, '');
}

/** 复制 / 分享 / 朗读用的纯文本：丢掉所有标记段，只留正文 */
function plainTextOf(segments: MarkerSegment[]): string {
  return segments
    .filter((seg): seg is Extract<MarkerSegment, { type: 'text' }> => seg.type === 'text')
    .map((seg) => seg.content)
    .join('');
}

function InlineFileCard({
  segment,
  onPreviewMd,
  colors,
  styles: s,
}: {
  segment: FileSegment & { owner?: string };
  onPreviewMd?: (filePath: string) => void;
  colors: ThemeColors;
  styles: ReturnType<typeof useMessageStyles>;
}) {
  // shared 的 marker 切分只给出路径与文件名，体积统一靠 HEAD 探测（与 web 同口径）。
  const [resolvedSize, setResolvedSize] = useState(0);
  const [downloading, setDownloading] = useState(false);

  const ownerParam = segment.owner ? `&owner=${encodeURIComponent(segment.owner)}` : '';

  useEffect(() => {
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
  }, [segment.filePath, ownerParam]);

  // Mobile only previews inert Markdown workspace files. HTML is fail-closed to Artifact delivery.
  const previewKind = getPreviewFileType(segment.fileName);
  const isPreviewable = previewKind === 'md';
  const isRetiredHtml = previewKind === 'html';
  const fileVisual = getFileTypeVisual(segment.fileName);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const { openOrShareFile } = await import('../../../utils/openOrShareFile');
      const uri = await fileCacheService.getOrDownload(segment.filePath, 0, 0, segment.owner);
      await openOrShareFile(uri);
    } catch (err: any) {
      Alert.alert('下载失败', `${err?.message || String(err)}\n\npath: ${segment.filePath}`);
    } finally {
      setDownloading(false);
    }
  }, [segment.filePath, segment.owner]);

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

  // 标记切分：文本段 + 文件卡 + 引用角标。流式时先裁掉半截 [CITE]/[FILE]。
  const segments = useMemo(
    () => splitByMessageMarkers(displaySourceOf(message.content, message.streaming)),
    [message.content, message.streaming],
  );
  const hasMarkers = segments.some((seg) => seg.type !== 'text');

  // 复制 / 分享 / 朗读用的纯文本（不含任何标记）
  const plainText = useMemo(
    () => (hasMarkers ? plainTextOf(segments) : message.content),
    [segments, hasMarkers, message.content],
  );

  /**
   * 标记段渲染：文件卡在流式期间不出现（那时 marker 可能仍不完整，
   * 已闭合的也先按裁剪口径不落卡片），引用角标则在流式中即可点开。
   */
  /** 文本段：先切出块级公式交给 MathBlock，其余照旧走 Markdown */
  const renderTextSegment = (content: string, key: string | number) => {
    const mathParts = splitMathSegments(content);
    if (mathParts.length === 1 && mathParts[0].type === 'text') {
      return (
        <Markdown key={key} markdownit={cjkMarkdownIt} style={mdStyles} rules={rules}>
          {content}
        </Markdown>
      );
    }
    return (
      <View key={key}>
        {mathParts.map((part, j) =>
          part.type === 'math' ? (
            <MathBlock key={j} tex={part.tex} />
          ) : (
            <Markdown key={j} markdownit={cjkMarkdownIt} style={mdStyles} rules={rules}>
              {part.content}
            </Markdown>
          ),
        )}
      </View>
    );
  };

  const renderSegments = (allowFileCards: boolean) =>
    segments.map((seg, i) => {
      if (seg.type === 'text') {
        return renderTextSegment(seg.content, i);
      }
      if (seg.type === 'citation') {
        return (
          <MessageCitationCard key={i} citation={seg} />
        );
      }
      if (!allowFileCards) return null;
      return (
        <InlineFileCard
          key={i}
          segment={{ ...seg, ...(message.owner ? { owner: message.owner } : {}) }}
          onPreviewMd={onPreviewMd}
          colors={colors}
          styles={styles}
        />
      );
    });

  /**
   * 气泡底部动作区：最终回复给「反馈」入口；门禁拒答气泡（携带
   * guardrailEventId）额外给「这个应该在范围内」申诉入口。
   * MessageFeedbackContext 缺省（个人 Agent 会话 / 数据面 503）时两个按钮
   * 都零渲染，容器随之收成空行，不改变非专职会话的既有版式。
   */
  const showAppeal = !message.streaming && !!message.guardrailEventId;
  const showFeedback = !message.streaming && !!message.finalOutput;
  const actionRow =
    showAppeal || showFeedback ? (
      <View style={styles.messageActions}>
        {message.guardrailEventId && showAppeal ? (
          <GuardrailAppealButton guardrailEventId={message.guardrailEventId} />
        ) : null}
        {showFeedback ? (
          <MessageFeedbackButton messageId={message.id} content={message.content} />
        ) : null}
      </View>
    ) : null;

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

  // 流式：正文与引用角标照常渲染，文件卡等本轮落定后再出现
  if (message.streaming) {
    return (
      <View style={styles.assistantBubble}>
        {finalOutputDivider}
        {renderSegments(false)}
        <View style={styles.cursor} />
        {lightboxUri && (
          <ImageLightbox visible uri={lightboxUri} onClose={() => setLightboxUri(null)} />
        )}
      </View>
    );
  }

  // 非流式且含标记：文本 / 文件卡 / 引用角标交错渲染
  if (hasMarkers) {
    return (
      <>
        <GestureDetector gesture={longPressGesture}>
          <View style={styles.assistantBubble}>
            {finalOutputDivider}
            {renderSegments(true)}
            {actionRow}
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
          {actionRow}
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
