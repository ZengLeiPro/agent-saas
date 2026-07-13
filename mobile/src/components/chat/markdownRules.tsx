import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, Linking, ScrollView, Dimensions, type ImageStyle } from 'react-native';
import { Image } from 'expo-image';
import { Check, Copy } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { MD_PATH_RE, HTML_PATH_RE, resolveImageSrc } from '@agent/shared';
import { useColors, typography as defaultTypography, radius, spacing } from '../../theme';
import type { ThemeColors } from '../../theme';
import { hapticLight } from '../../lib/haptics';
import { InlineVideoPlayer } from './InlineVideoPlayer';

const VIDEO_EXT_RE = /\.(mp4|mov|webm|m4v|avi)$/i;

interface MarkdownRulesOptions {
  onPreviewMd?: (filePath: string) => void;
  onImagePress?: (uri: string) => void;
  colors: ThemeColors;
  /** 文件所属用户（admin 查看其他用户会话时需要） */
  owner?: string;
  typo?: typeof defaultTypography;
  /** 是否允许文字选择（预览页启用，聊天消息禁用以避免与长按手势冲突） */
  selectable?: boolean;
}

function CopyButton({ content }: { content: string }) {
  const colors = useColors();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    hapticLight();
    await Clipboard.setStringAsync(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [content]);

  const styles = useMemo(() => StyleSheet.create({
    copyButton: {
      position: 'absolute',
      top: 6,
      right: 6,
      zIndex: 10,
      width: 28,
      height: 28,
      borderRadius: 6,
      backgroundColor: colors.secondary,
      justifyContent: 'center',
      alignItems: 'center',
    },
  }), [colors]);

  return (
    <Pressable onPress={handleCopy} style={styles.copyButton}>
      {copied ? (
        <Check size={16} color={colors.success} strokeWidth={2} />
      ) : (
        <Copy size={16} color={colors.mutedForeground} strokeWidth={2} />
      )}
    </Pressable>
  );
}

/** Recursively extract plain text from a markdown AST node */
function extractText(node: any): string {
  if (node.content) return node.content;
  if (!node.children?.length) return '';
  return node.children.map(extractText).join('');
}

const CELL_PAD_H = 16;

function estimateTextWidth(text: string, tableFontSize: number): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      (c >= 0x4E00 && c <= 0x9FFF) ||
      (c >= 0x3400 && c <= 0x4DBF) ||
      (c >= 0x3000 && c <= 0x303F) ||
      (c >= 0xFF00 && c <= 0xFFEF) ||
      (c >= 0xAC00 && c <= 0xD7AF)
    ) {
      w += tableFontSize;
    } else if (c === 0x20) {
      w += tableFontSize * 0.27;
    } else {
      w += tableFontSize * 0.54;
    }
  }
  return w;
}

/**
 * 列宽算法：允许换行 + 硬约束「单元格最多 4 行」。
 *
 * 思路：自然换行行数 = ⌈文本宽度 / 列宽⌉，要保证 ≤ 4 行，必须 列宽 ≥ 文本宽度 / 4。
 * 取每列所有 cell 这个需求的最大值作为列宽下限 colMinWidth。
 *
 * - 所有列 colMinWidth 之和 ≥ available：维持下限，超出部分由 horizontal ScrollView 横滚兜底
 * - 所有列 colMinWidth 之和 < available：剩余空间按"该列最大文本宽度"占比加宽，
 *   让短列保持紧凑、长列吃到更多空间（视觉上接近内容比例分配）
 *
 * cell 的 <Text> 不设 numberOfLines，因此宽度给定后会自然换行，最多 4 行。
 */
function computeColumnWidths(tableNode: any, tableFontSize: number): number[] {
  const screenW = Dimensions.get('window').width;
  const available = screenW - 32;
  const MIN_W = 48;
  const MAX_LINES = 4;

  const allRows: string[][] = [];
  for (const section of tableNode.children || []) {
    if (section.type === 'thead' || section.type === 'tbody') {
      for (const tr of section.children || []) {
        allRows.push((tr.children || []).map(extractText));
      }
    }
  }
  if (!allRows.length) return [];

  const colCount = Math.max(...allRows.map(r => r.length));

  const colMinWidth: number[] = [];
  const colTextWidth: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let maxTextW = 0;
    let maxNeedW = 0;
    for (const row of allRows) {
      if (c < row.length) {
        const tw = estimateTextWidth(row[c], tableFontSize);
        if (tw > maxTextW) maxTextW = tw;
        const need = Math.ceil(tw / MAX_LINES) + CELL_PAD_H;
        if (need > maxNeedW) maxNeedW = need;
      }
    }
    colMinWidth.push(Math.max(MIN_W, maxNeedW));
    colTextWidth.push(maxTextW);
  }

  const totalMin = colMinWidth.reduce((s, w) => s + w, 0);
  if (totalMin >= available) {
    return colMinWidth.map(w => Math.round(w));
  }

  const extra = available - totalMin;
  const totalText = colTextWidth.reduce((s, w) => s + w, 0);
  if (totalText === 0) {
    const avg = extra / colCount;
    return colMinWidth.map(w => Math.round(w + avg));
  }
  return colMinWidth.map((minW, i) => Math.round(minW + (colTextWidth[i] / totalText) * extra));
}

function CodeBlockContent({ code, colors, typo }: { code: string; colors: ThemeColors; typo: typeof defaultTypography }) {
  const styles = useMemo(() => StyleSheet.create({
    codeLineContainer: {
      flexShrink: 0,
      padding: 12,
    },
    codeLine: {
      ...typo.mono,
      color: colors.foreground,
    },
  }), [colors, typo]);

  const lines = code.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return (
    <View style={styles.codeLineContainer}>
      {lines.map((line, i) => (
        <Text key={i} style={styles.codeLine} numberOfLines={1}>
          {line || ' '}
        </Text>
      ))}
    </View>
  );
}

const IMAGE_MAX_WIDTH = Dimensions.get('window').width - 48; // 消息区域留 padding

/** 根据图片实际尺寸自适应宽度，保持比例 */
function AutoSizeImage({ uri, onPress }: { uri: string; onPress?: () => void }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const style: ImageStyle = size
    ? {
        width: Math.min(size.width, IMAGE_MAX_WIDTH),
        height: Math.min(size.width, IMAGE_MAX_WIDTH) * (size.height / size.width),
        borderRadius: radius.md,
        marginVertical: 4,
      }
    : { width: IMAGE_MAX_WIDTH, height: 150, borderRadius: radius.md, marginVertical: 4 };

  return (
    <Pressable onPress={() => onPress?.()}>
      <Image
        source={{ uri }}
        style={style}
        contentFit="contain"
        cachePolicy="disk"
        onLoad={(e) => {
          const { width: w, height: h } = e.source;
          if (w && h) setSize({ width: w, height: h });
        }}
      />
    </Pressable>
  );
}

/** Wrapper: resolves workspace paths and passes resolved URI to lightbox */
function WorkspaceImage({ src, owner, onImagePress }: { src: string; owner?: string; onImagePress?: (uri: string) => void }) {
  const colors = useColors();
  const [resolvedUri, setResolvedUri] = useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    resolveImageSrc(src, owner)
      .then(resolved => { if (!cancelled) setResolvedUri(resolved); })
      .catch(() => { if (!cancelled) setResolvedUri(src); });
    return () => { cancelled = true; };
  }, [src, owner]);

  if (!resolvedUri) {
    return <View style={{ width: IMAGE_MAX_WIDTH, height: 150, borderRadius: radius.md, backgroundColor: colors.muted }} />;
  }

  return (
    <AutoSizeImage
      uri={resolvedUri}
      onPress={() => onImagePress?.(resolvedUri)}
    />
  );
}

export function createRuleStyles(colors: ThemeColors, typo = defaultTypography) {
  return StyleSheet.create({
    codeBlockWrapper: {
      position: 'relative',
      marginVertical: 4,
    },
    codeScrollView: {
      borderRadius: radius.md,
      backgroundColor: colors.codeBlockBg,
    },
    mdLink: {
      color: colors.link,
      textDecorationLine: 'none',
    },
    // Table
    tableScrollView: {
      marginVertical: 8,
    },
    tableContainer: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderStrong,
      borderRadius: radius.sm,
    },
    tableRow: {
      flexDirection: 'row',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    tableHeadRow: {
      backgroundColor: colors.secondary,
    },
    thCell: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
    },
    tdCell: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
    },
    thText: {
      ...typo.bodySmall,
      fontWeight: '600',
      color: colors.foreground,
    },
    tdText: {
      ...typo.bodySmall,
      color: colors.foreground,
    },
  });
}

export function createMarkdownRules(options: MarkdownRulesOptions) {
  const { onPreviewMd, onImagePress, colors, owner, typo = defaultTypography, selectable } = options;
  const ruleStyles = createRuleStyles(colors, typo);
  const tableFontSize = typo.bodySmall.fontSize!;

  return {
    textgroup: (node: any, children: any, parent: any, styles: any) => (
      <Text key={node.key} style={styles.textgroup} selectable={selectable}>{children}</Text>
    ),

    fence: (node: any, children: any, parent: any, styles: any) => {
      const code = node.content || '';
      return (
        <View key={node.key} style={ruleStyles.codeBlockWrapper}>
          <CopyButton content={code} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled style={ruleStyles.codeScrollView}>
            <CodeBlockContent code={code} colors={colors} typo={typo} />
          </ScrollView>
        </View>
      );
    },

    code_block: (node: any, children: any, parent: any, styles: any) => {
      const code = node.content || '';
      return (
        <View key={node.key} style={ruleStyles.codeBlockWrapper}>
          <CopyButton content={code} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled style={ruleStyles.codeScrollView}>
            <CodeBlockContent code={code} colors={colors} typo={typo} />
          </ScrollView>
        </View>
      );
    },

    code_inline: (node: any, children: any, parent: any, styles: any) => {
      const text = node.content || '';
      if (onPreviewMd && (MD_PATH_RE.test(text) || HTML_PATH_RE.test(text))) {
        return (
          <Text
            key={node.key}
            style={ruleStyles.mdLink}
            onPress={() => onPreviewMd(text)}
          >
            {text}
          </Text>
        );
      }
      return (
        <Text key={node.key} style={styles.code_inline}>
          {text}
        </Text>
      );
    },

    link: (node: any, children: any, parent: any, styles: any) => {
      const href: string = node.attributes?.href || '';
      const isPreviewableLink = onPreviewMd && /\.(md|html?)$/i.test(href) && !/^[a-zA-Z]+:\/\//.test(href);
      return (
        <Text
          key={node.key}
          style={isPreviewableLink ? [styles.link, ruleStyles.mdLink] : styles.link}
          onPress={() => {
            if (!href) return;
            if (isPreviewableLink) {
              onPreviewMd!(href);
            } else {
              void Linking.openURL(href);
            }
          }}
        >
          {children}
        </Text>
      );
    },

    image: (node: any, children: any, parent: any, styles: any) => {
      const src = node.attributes?.src || '';
      if (!src) return null;
      if (VIDEO_EXT_RE.test(src)) {
        return <InlineVideoPlayer key={node.key} src={src} owner={owner} />;
      }
      return (
        <WorkspaceImage
          key={node.key}
          src={src}
          owner={owner}
          onImagePress={onImagePress}
        />
      );
    },

    table: (node: any, _children: any, _parent: any, _styles: any) => {
      const widths = computeColumnWidths(node, tableFontSize);
      const totalWidth = widths.reduce((s, w) => s + w, 0);
      const thead = node.children?.find((c: any) => c.type === 'thead');
      const tbody = node.children?.find((c: any) => c.type === 'tbody');

      const renderCell = (cell: any, colIdx: number, isHead: boolean) => (
        <View key={cell.key} style={[isHead ? ruleStyles.thCell : ruleStyles.tdCell, { width: widths[colIdx] ?? 120, flexShrink: 0 }]}>
          <Text style={isHead ? ruleStyles.thText : ruleStyles.tdText} selectable={selectable}>{extractText(cell)}</Text>
        </View>
      );

      const renderRow = (tr: any, isHead: boolean) => (
        <View key={tr.key} style={[ruleStyles.tableRow, isHead && ruleStyles.tableHeadRow]}>
          {(tr.children || []).map((cell: any, i: number) => renderCell(cell, i, isHead))}
        </View>
      );

      return (
        <ScrollView key={node.key} horizontal showsHorizontalScrollIndicator nestedScrollEnabled style={ruleStyles.tableScrollView}>
          <View style={[ruleStyles.tableContainer, totalWidth > 0 && { width: totalWidth, flexShrink: 0 }]}>
            {(thead?.children || []).map((tr: any) => renderRow(tr, true))}
            {(tbody?.children || []).map((tr: any) => renderRow(tr, false))}
          </View>
        </ScrollView>
      );
    },

    thead: (node: any, children: any, parent: any, styles: any) => (
      <View key={node.key}>{children}</View>
    ),

    tbody: (node: any, children: any, parent: any, styles: any) => (
      <View key={node.key}>{children}</View>
    ),

    tr: (node: any, children: any, parent: any, styles: any) => {
      const isHead = parent[0]?.type === 'thead';
      return (
        <View
          key={node.key}
          style={[ruleStyles.tableRow, isHead && ruleStyles.tableHeadRow]}
        >
          {children}
        </View>
      );
    },

    th: (node: any, _children: any, _parent: any, _styles: any) => {
      const text = extractText(node);
      return (
        <View key={node.key} style={ruleStyles.thCell}>
          <Text style={ruleStyles.thText} selectable={selectable}>{text}</Text>
        </View>
      );
    },

    td: (node: any, _children: any, _parent: any, _styles: any) => {
      const text = extractText(node);
      return (
        <View key={node.key} style={ruleStyles.tdCell}>
          <Text style={ruleStyles.tdText} selectable={selectable}>{text}</Text>
        </View>
      );
    },
  };
}
