/** 文件下载 / Artifact 卡片：懒加载文件大小、Markdown 预览与授权下载。 */
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { Download } from 'lucide-react-native';
import type { MessageItem } from '@agent/shared';
import { authFetch, formatFileSize, getFileTypeVisual, getPreviewFileType } from '@agent/shared';
import { fileCacheService } from '../../../services/fileCacheService';
import { useColors, useChatTypography } from '../../../theme';
import {
  fetchMobileArtifactGrant,
  mobileArtifactWarning,
  selectMobileArtifactViewer,
} from '../../../lib/artifactViewAdapter';
import { CATEGORY_ICON, useMessageStyles } from './shared';

// --- File Download ---
export function FileDownloadCard({
  message,
  onPreviewMd,
}: {
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
    authFetch(`/api/file/download?path=${encodeURIComponent(message.filePath)}${ownerParam}`, {
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
        if (
          selectMobileArtifactViewer(grant) === 'download-only' ||
          grant.descriptor.requiresWarning
        ) {
          const confirmed = await new Promise<boolean>((resolve) =>
            Alert.alert(
              '确认下载此文件？',
              mobileArtifactWarning(grant),
              [
                { text: '取消', style: 'cancel', onPress: () => resolve(false) },
                { text: '仍要下载', style: 'destructive', onPress: () => resolve(true) },
              ],
              { cancelable: true, onDismiss: () => resolve(false) },
            ),
          );
          if (!confirmed) return;
          grant = await fetchMobileArtifactGrant(artifactId, true);
        }
        const { openOrShareUrl } = await import('../../../utils/openOrShareFile');
        await openOrShareUrl(grant.readUrl, grant.descriptor.name);
        return;
      }
      const { openOrShareFile } = await import('../../../utils/openOrShareFile');
      const uri = await fileCacheService.getOrDownload(
        message.filePath,
        0,
        message.fileSize || 0,
        message.owner,
      );
      await openOrShareFile(uri);
    } catch (err: any) {
      // Never emit signed URLs/tokens to console, analytics, crash logs or user-visible errors.
      const messageText = artifactId
        ? 'Artifact 暂时无法安全打开，请稍后重试'
        : err?.message || String(err);
      if (!artifactId) console.error('File download/share failed for legacy workspace file');
      Alert.alert('下载失败', messageText);
    } finally {
      setDownloading(false);
    }
  }, [artifactId, message.filePath, message.fileName, message.fileSize, message.owner]);

  const handlePress = useCallback(async () => {
    // Formal artifacts stay on the M50-02 artifactId/grant path. Legacy workspace HTML fails closed.
    if (!artifactId && isRetiredHtml) {
      Alert.alert(
        '旧预览已停用',
        'Mobile V1 不打开 workspace HTML。正式交付请使用 Artifact viewer。',
      );
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
        {React.createElement(CATEGORY_ICON[fileVisual.category], {
          size: 20,
          color: colors.primaryForeground /* token: 近似 纯白 */,
          strokeWidth: 2,
        })}
      </View>
      <View style={styles.fileCardInfo}>
        <Text style={styles.fileName} numberOfLines={1}>
          {message.fileName}
        </Text>
        {resolvedSize > 0 && <Text style={styles.fileSize}>{formatFileSize(resolvedSize)}</Text>}
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
