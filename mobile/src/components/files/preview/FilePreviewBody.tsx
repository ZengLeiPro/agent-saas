/**
 * File preview body — shared by `/files/preview` and md+ files master-detail pane.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { resolveImageSrc } from '@agent/shared';
import { EmptyState } from '../../ui';
import { EntityIcons } from '../../../lib/icons';
import { resolveFilePreviewKind, resolveKbPreviewSource } from '../../../lib/filePreviewTarget';
import { fetchFileText } from '../../../services/fileTextService';
import { fileCacheService } from '../../../services/fileCacheService';
import { openOrShareFile } from '../../../utils/openOrShareFile';
import { useColors, spacing, fontScale } from '../../../theme';
import { ActiveContentNotice } from './ActiveContentNotice';
import { CodePreview } from './CodePreview';
import { PdfPreview } from './PdfPreview';
import { VideoPreview } from './VideoPreview';

export type FilePreviewBodyProps = {
  filePath: string;
  name?: string;
  size?: number;
  modifiedAt?: number;
  owner?: string;
  root?: boolean;
  /** Expose download handler for parent header menus. */
  onDownloadingChange?: (busy: boolean) => void;
  downloadRef?: React.MutableRefObject<(() => Promise<void>) | null>;
};

export function FilePreviewBody({
  filePath,
  name,
  size = 0,
  modifiedAt = 0,
  owner,
  root,
  onDownloadingChange,
  downloadRef,
}: FilePreviewBodyProps) {
  const colors = useColors();
  const isRootMode = root === true;
  const kb = useMemo(() => resolveKbPreviewSource(filePath), [filePath]);
  const fileName = name || kb.doc.split('/').pop() || kb.doc || '预览';
  const kind = useMemo(() => resolveFilePreviewKind(filePath), [filePath]);

  const [text, setText] = useState<string | null>(null);
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [mediaUri, setMediaUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(kind !== 'html');
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [downloading, setDownloading] = useState(false);

  const fileOptions = useMemo(
    () => ({ ...(owner ? { owner } : {}), ...(isRootMode ? { root: true } : {}) }),
    [owner, isRootMode],
  );

  const downloadToCache = useCallback(
    () =>
      fileCacheService.getOrDownload(filePath, modifiedAt, size, owner, isRootMode || undefined),
    [filePath, modifiedAt, size, owner, isRootMode],
  );

  useEffect(() => {
    if (!filePath) {
      setError('未提供文件路径');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setError(null);
    setText(null);
    setLocalUri(null);
    setMediaUri(null);

    const load = async () => {
      if (kind === 'code' || kind === 'text') {
        setText(await fetchFileText(filePath, fileOptions));
        return;
      }
      if (kind === 'pdf') {
        const uri = await downloadToCache();
        if (!cancelled) setLocalUri(uri);
        return;
      }
      if (kind === 'video') {
        const uri = kb.isKb ? await downloadToCache() : await resolveImageSrc(filePath, owner);
        if (!cancelled) setMediaUri(uri);
      }
    };

    if (kind === 'html' || kind === 'download') {
      setLoading(false);
      return;
    }

    setLoading(true);
    load()
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath, kind, kb.isKb, owner, fileOptions, downloadToCache, reloadToken]);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    onDownloadingChange?.(true);
    try {
      const uri = localUri ?? (await downloadToCache());
      setLocalUri(uri);
      await openOrShareFile(uri);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDownloading(false);
      onDownloadingChange?.(false);
    }
  }, [localUri, downloadToCache, onDownloadingChange]);

  useEffect(() => {
    if (downloadRef) downloadRef.current = handleDownload;
    return () => {
      if (downloadRef) downloadRef.current = null;
    };
  }, [downloadRef, handleDownload]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.card },
        center: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacing.lg,
        },
        hint: { ...fontScale.base },
      }),
    [colors],
  );

  if (kind === 'html' || kind === 'download') {
    return (
      <View style={styles.container} testID="file-preview-body">
        <ActiveContentNotice
          fileName={fileName}
          size={size}
          downloading={downloading}
          onDownload={() => {
            void handleDownload();
          }}
        />
      </View>
    );
  }

  if (kind === 'pdf') {
    return (
      <View style={styles.container} testID="file-preview-body">
        <PdfPreview
          localUri={localUri}
          loading={loading}
          error={error}
          fileName={fileName}
          size={size}
          {...(kb.page ? { page: kb.page } : {})}
          onRetry={() => setReloadToken((token) => token + 1)}
        />
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.container, styles.center]} testID="file-preview-body">
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.container, styles.center]} testID="file-preview-body">
        <EmptyState
          icon={EntityIcons.files}
          title="预览失败"
          description={error}
          actionLabel="重试"
          onAction={() => setReloadToken((token) => token + 1)}
        />
      </View>
    );
  }

  if (kind === 'video') {
    return (
      <View style={styles.container} testID="file-preview-body">
        <VideoPreview uri={mediaUri} />
      </View>
    );
  }

  if (text !== null) {
    return (
      <View style={styles.container} testID="file-preview-body">
        <CodePreview content={text} fileName={fileName} />
      </View>
    );
  }

  return (
    <View style={[styles.container, styles.center]} testID="file-preview-body">
      <Text style={[styles.hint, { color: colors.mutedForeground }]}>该类型不支持内嵌预览</Text>
    </View>
  );
}

export function filePreviewDisplayName(filePath: string, name?: string): string {
  if (name) return name;
  const kb = resolveKbPreviewSource(filePath);
  return kb.doc.split('/').pop() || kb.doc || '预览';
}
