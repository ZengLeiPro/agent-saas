/**
 * PDF 预览 —— 走系统原生阅读器（iOS QLPreviewController / Android 文档 viewer），
 * 由 `openOrShareFile` 统一封装（`@react-native-documents/viewer`，失败自动回落分享面板）。
 *
 * 安全边界：只把**本地缓存文件**交给 viewer，绝不把远程 URL 或 HTML 送进任何 WebView
 * （M50-03：移动端不存在内嵌 HTML/远程渲染面）。
 *
 * 已知能力缺口：`viewDocument` 没有页码参数，KB 引用卡的 `#page=N` 无法定位，
 * 只能从第一页打开（详见 files 预览路由的注释）。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { formatFileSize } from '@agent/shared';
import { Button, EmptyState } from '../../ui';
import { EntityIcons } from '../../../lib/icons';
import { useColors, spacing, fontScale } from '../../../theme';
import { openOrShareFile } from '../../../utils/openOrShareFile';

export interface PdfPreviewProps {
  /** 已下载到应用缓存目录的本地 file:// URI */
  localUri: string | null;
  loading: boolean;
  error: string | null;
  fileName: string;
  size?: number;
  /** 引用卡带来的页码；当前 viewer 不支持定位，仅作提示 */
  page?: number;
  onRetry: () => void;
}

export function PdfPreview({
  localUri,
  loading,
  error,
  fileName,
  size,
  page,
  onRetry,
}: PdfPreviewProps) {
  const colors = useColors();
  const [opening, setOpening] = useState(false);

  const openViewer = useCallback(async () => {
    if (!localUri) return;
    setOpening(true);
    try {
      await openOrShareFile(localUri);
    } finally {
      setOpening(false);
    }
  }, [localUri]);

  // 下载完成即自动拉起系统阅读器，行为贴近 Web 打开即渲染
  useEffect(() => {
    if (localUri) void openViewer();
    // openViewer 依赖 localUri，这里只在首次拿到本地文件时触发
  }, [localUri]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <View style={styles.center} testID="pdf-preview-loading">
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>正在下载 PDF…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <EmptyState
          icon={EntityIcons.files}
          title="PDF 加载失败"
          description={error}
          actionLabel="重试"
          onAction={onRetry}
        />
      </View>
    );
  }

  return (
    <View style={styles.center} testID="pdf-preview">
      <EmptyState
        icon={EntityIcons.files}
        title={fileName}
        description={[
          size ? formatFileSize(size) : '',
          page ? `引用第 ${page} 页（系统阅读器不支持跳页，请手动翻页）` : '',
        ]
          .filter(Boolean)
          .join(' · ')}
      />
      <Button
        label={opening ? '打开中…' : '用系统阅读器打开'}
        onPress={() => {
          void openViewer();
        }}
        variant="primary"
        size="md"
        disabled={opening}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  hint: {
    ...fontScale.sm,
  },
});
