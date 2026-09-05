/**
 * 通用文件预览路由 —— 对齐 Web `FilePreviewPanel` 的分派，
 * 按 shared `getPreviewFileType`（封装见 `lib/filePreviewTarget.ts`）落到四种呈现：
 *
 *   code / text → `CodePreview`（等宽 + 行号 + 横向滚动，超大按 ARTIFACT_TEXT_MAX_BYTES 截断）
 *   pdf         → `PdfPreview`（下载到应用缓存后交系统原生阅读器）
 *   video       → `VideoPreview`（expo-video 内联）
 *   html / svg  → `ActiveContentNotice`（只给下载/分享 + 安全提示，M50-03 不内嵌渲染）
 *
 * Markdown 不进这里：保留会话内既有入口 `/chat/markdown-preview`。
 * 顶栏动作对齐 Web `FilePreviewActions` 的「下载」并补「分享」；
 * 「打印」在 RN 无对应系统能力（无 window.print / 无统一打印面板），本期省略。
 *
 * 能力缺口：`@react-native-documents/viewer` 的 `viewDocument` 没有页码参数，
 * KB 引用卡的 `#page=N` 无法定位到指定页，只能提示用户手动翻页。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, type View as RNView } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { resolveImageSrc } from '@agent/shared';
import { DropdownMenu, type DropdownSection } from '../../src/components/overlays/DropdownMenu';
import { HeaderMenuButton } from '../../src/components/files/fileHeaderItems';
import { ActiveContentNotice } from '../../src/components/files/preview/ActiveContentNotice';
import { CodePreview } from '../../src/components/files/preview/CodePreview';
import { PdfPreview } from '../../src/components/files/preview/PdfPreview';
import { VideoPreview } from '../../src/components/files/preview/VideoPreview';
import { EmptyState } from '../../src/components/ui';
import { EntityIcons } from '../../src/lib/icons';
import { resolveFilePreviewKind, resolveKbPreviewSource } from '../../src/lib/filePreviewTarget';
import { glassFree } from '../../src/lib/headerItems';
import { fetchFileText } from '../../src/services/fileTextService';
import { fileCacheService } from '../../src/services/fileCacheService';
import { openOrShareFile } from '../../src/utils/openOrShareFile';
import { useColors, spacing, fontScale } from '../../src/theme';

export default function FilePreviewScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{
    filePath: string;
    name?: string;
    size?: string;
    modifiedAt?: string;
    owner?: string;
    root?: string;
  }>();

  const filePath = params.filePath ?? '';
  const owner = params.owner;
  const isRootMode = params.root === 'true';
  const size = Number(params.size ?? '0') || 0;
  const modifiedAt = Number(params.modifiedAt ?? '0') || 0;

  const kb = useMemo(() => resolveKbPreviewSource(filePath), [filePath]);
  const fileName = params.name || kb.doc.split('/').pop() || kb.doc || '预览';
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

  /** 拉本地缓存文件（PDF 与 KB 媒体都要落盘后再交给原生组件） */
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
        // KB 视频没有带鉴权的流式地址，先落盘再播；工作区沿用既有鉴权 URL。
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

  // ── 顶栏动作：下载 / 分享 / 复制路径（对齐 Web FilePreviewActions，去掉打印） ──
  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const uri = localUri ?? (await downloadToCache());
      setLocalUri(uri);
      await openOrShareFile(uri);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDownloading(false);
    }
  }, [localUri, downloadToCache]);

  const [menuVisible, setMenuVisible] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState(0);
  const menuTriggerRef = useRef<RNView>(null);

  const openMenu = useCallback(() => {
    menuTriggerRef.current?.measureInWindow((_x, y, _w, h) => {
      setMenuAnchor(y + h);
      setMenuVisible(true);
    });
  }, []);

  const menuSections = useMemo<DropdownSection[]>(
    () => [
      {
        id: 'actions',
        actions: [
          { id: 'download', label: '下载 / 分享' },
          { id: 'copy-path', label: '复制路径' },
        ],
      },
    ],
    [],
  );

  const handleMenuSelect = useCallback(
    (actionId: string) => {
      if (actionId === 'download') void handleDownload();
      else if (actionId === 'copy-path') void Clipboard.setStringAsync(kb.doc || filePath);
    },
    [handleDownload, kb.doc, filePath],
  );

  const headerRight = useCallback(
    () => (
      <HeaderMenuButton onPress={openMenu} triggerRef={menuTriggerRef} testID="file-preview-menu" />
    ),
    [openMenu],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.card }]} testID="file-preview-screen">
      <Stack.Screen
        options={{
          title: fileName,
          headerRight,
          unstable_headerRightItems: () => [glassFree(headerRight())],
        }}
      />

      {renderBody()}

      <DropdownMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        sections={menuSections}
        onSelect={handleMenuSelect}
        anchorTop={menuAnchor}
        align="right"
      />
    </View>
  );

  function renderBody() {
    if (kind === 'html' || kind === 'download') {
      return (
        <ActiveContentNotice
          fileName={fileName}
          size={size}
          downloading={downloading}
          onDownload={() => {
            void handleDownload();
          }}
        />
      );
    }

    if (kind === 'pdf') {
      return (
        <PdfPreview
          localUri={localUri}
          loading={loading}
          error={error}
          fileName={fileName}
          size={size}
          {...(kb.page ? { page: kb.page } : {})}
          onRetry={() => setReloadToken((token) => token + 1)}
        />
      );
    }

    if (loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      );
    }

    if (error) {
      return (
        <View style={styles.center}>
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

    if (kind === 'video') return <VideoPreview uri={mediaUri} />;

    if (text !== null) return <CodePreview content={text} fileName={fileName} />;

    return (
      <View style={styles.center}>
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>该类型不支持内嵌预览</Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  hint: {
    ...fontScale.base,
  },
});
