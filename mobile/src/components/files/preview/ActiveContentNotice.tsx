/**
 * HTML / SVG 等「主动内容」的安全提示页。
 *
 * M50-03 的既定边界：移动端不存在 workspace HTML 的内嵌渲染面，
 * 目录 token 路径已删；`artifactViewAdapter` 也把 artifact 的 `html` viewKind
 * 映射为 `download-only`（`MOBILE_VIEWERS.html`）。因此文件中心遇到 HTML/SVG
 * 一律停在这里：只给「下载 / 分享」，不提供任何渲染入口，与 Artifact 侧口径一致。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatFileSize } from '@agent/shared';
import { Button, EmptyState } from '../../ui';
import { EntityIcons } from '../../../lib/icons';
import { useColors, spacing, fontScale } from '../../../theme';

export interface ActiveContentNoticeProps {
  fileName: string;
  size?: number;
  downloading: boolean;
  onDownload: () => void;
}

export function ActiveContentNotice({
  fileName,
  size,
  downloading,
  onDownload,
}: ActiveContentNoticeProps) {
  const colors = useColors();
  return (
    <View style={styles.container} testID="active-content-notice">
      <EmptyState
        icon={EntityIcons.files}
        title={fileName}
        description={size ? formatFileSize(size) : undefined}
      />
      <View style={[styles.warning, { backgroundColor: colors.muted }]}>
        <Text style={[styles.warningText, { color: colors.mutedForeground }]}>
          此文件包含主动内容（HTML / SVG 可执行脚本），移动端不在应用内渲染。
          {'\n\n'}
          需要查看时请下载后用可信的原生应用打开；正式交付请走 Artifact viewer。
        </Text>
      </View>
      <Button
        label={downloading ? '准备中…' : '下载 / 分享'}
        onPress={onDownload}
        variant="primary"
        size="md"
        disabled={downloading}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  warning: {
    borderRadius: spacing.md,
    padding: spacing.md,
  },
  warningText: {
    ...fontScale.sm,
  },
});
