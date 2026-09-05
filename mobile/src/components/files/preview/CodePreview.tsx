/**
 * 代码 / 纯文本预览 —— 对齐 Web `CodePreviewPanel` 的信息密度，但**不引入语法高亮依赖**：
 * 等宽字体 + 行号槽 + 横向滚动（长行不折行，与 Web 的 `overflow-x` 行为一致）。
 *
 * 超大文件按 shared `truncateTextPreview`（默认上限 `ARTIFACT_TEXT_MAX_BYTES`）截断，
 * 顶部给出明确提示，避免整份文件进 JS 内存把主线程拖垮。
 */
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ARTIFACT_TEXT_MAX_BYTES, formatFileSize } from '@agent/shared';
import { preparePreviewText } from '../../../lib/previewTextFormat';
import { useColors, spacing, fontScale, fontWeight, monoFamily } from '../../../theme';

export interface CodePreviewProps {
  content: string;
  /** 纯文本（txt/log/csv）不做 JSON 美化 */
  fileName: string;
  maxBytes?: number;
}

export function CodePreview({
  content,
  fileName,
  maxBytes = ARTIFACT_TEXT_MAX_BYTES,
}: CodePreviewProps) {
  const colors = useColors();

  const prepared = useMemo(
    () => preparePreviewText(content, fileName, maxBytes),
    [content, fileName, maxBytes],
  );
  const { lines } = prepared;

  const gutterWidth = useMemo(
    () => Math.max(2, String(lines.length).length) * 10 + spacing.sm,
    [lines.length],
  );

  return (
    <View style={styles.container} testID="code-preview">
      {prepared.truncated ? (
        <View style={[styles.notice, { backgroundColor: colors.muted }]}>
          <Text style={[styles.noticeText, { color: colors.mutedForeground }]}>
            文件过大（{formatFileSize(prepared.totalBytes)}），已截断为前{' '}
            {formatFileSize(prepared.keptBytes)}；完整内容请下载后查看。
          </Text>
        </View>
      ) : null}
      <ScrollView style={styles.vertical} contentContainerStyle={styles.verticalContent}>
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <View>
            {lines.map((line, index) => (
              <View key={index} style={styles.line}>
                <Text
                  style={[styles.gutter, { width: gutterWidth, color: colors.mutedForeground }]}
                  selectable={false}
                >
                  {index + 1}
                </Text>
                <Text style={[styles.code, { color: colors.foreground }]} selectable>
                  {line || ' '}
                </Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  notice: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  noticeText: {
    ...fontScale.xs,
  },
  vertical: { flex: 1 },
  verticalContent: {
    paddingVertical: spacing.sm,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  gutter: {
    ...fontScale.xs,
    fontFamily: monoFamily,
    textAlign: 'right',
    paddingRight: spacing.sm,
  },
  code: {
    ...fontScale.xs,
    fontFamily: monoFamily,
    fontWeight: fontWeight.regular,
    paddingRight: spacing.lg,
  },
});
