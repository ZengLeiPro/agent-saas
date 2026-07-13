import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { View, Text, ActivityIndicator, ScrollView, StyleSheet, Pressable, TouchableOpacity, Alert } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MoreHorizontal } from 'lucide-react-native';
import { DropdownMenu, type DropdownSection } from '../../src/components/overlays/DropdownMenu';
import { BackButton } from '../../src/components/BackButton';
import * as Clipboard from 'expo-clipboard';
import { authFetch } from '@agent/shared';
import { fileCacheService } from '../../src/services/fileCacheService';
import { textContentCache } from '../../src/services/textContentCache';
import Markdown from 'react-native-markdown-display';
import { createMarkdownStyles } from '../../src/components/chat/markdownStyles';
import { createMarkdownRules } from '../../src/components/chat/markdownRules';
import { useColors, spacing, typography, useChatTypography } from '../../src/theme';
import { glassFree } from '../../src/lib/headerItems';
import { ImageLightbox } from '../../src/components/chat/ImageLightbox';

export default function MarkdownPreviewScreen() {
  const colors = useColors();
  const { filePath, owner, root } = useLocalSearchParams<{ filePath: string; owner?: string; root?: string }>();
  const isRootMode = root === 'true';
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);
  const typo = useChatTypography();

  const fileName = filePath ? filePath.split('/').pop() || filePath : '';
  const dirPath = filePath && filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';

  const handleDownload = useCallback(async () => {
    if (!filePath) return;
    try {
      const { openOrShareFile } = await import('../../src/utils/openOrShareFile');
      const uri = await fileCacheService.getOrDownload(filePath, 0, 0, owner, isRootMode || undefined);
      await openOrShareFile(uri);
    } catch (err: any) {
      Alert.alert('下载失败', err?.message || String(err));
    }
  }, [filePath, fileName, owner, isRootMode]);

  const [headerMenuVisible, setHeaderMenuVisible] = useState(false);
  const [headerMenuAnchor, setHeaderMenuAnchor] = useState(0);
  const headerMenuTriggerRef = useRef<View>(null);

  const handleOpenHeaderMenu = useCallback(() => {
    headerMenuTriggerRef.current?.measureInWindow((_x, y, _w, h) => {
      setHeaderMenuAnchor(y + h);
      setHeaderMenuVisible(true);
    });
  }, []);

  const menuSections = useMemo<DropdownSection[]>(() => [{
    id: 'actions',
    actions: [
      { id: 'copy-path', label: '复制路径' },
      { id: 'download', label: '下载' },
    ],
  }], []);

  const handleMenuSelect = useCallback(async (actionId: string) => {
    switch (actionId) {
      case 'copy-path':
        await Clipboard.setStringAsync(filePath || '');
        break;
      case 'download':
        await handleDownload();
        break;
    }
  }, [filePath, handleDownload]);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.card,
    },
    centered: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      gap: 12,
    },
    errorText: {
      ...typography.body,
      color: colors.mutedForeground,
    },
    scrollView: {
      flex: 1,
    },
    scrollContent: {
      paddingHorizontal: 14,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
    },
  }), [colors]);

  const mdStyles = useMemo(() => createMarkdownStyles(colors, typo), [colors, typo]);

  useEffect(() => {
    if (!filePath) {
      setError('未提供文件路径');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    // 1. Try cache first
    textContentCache.get(filePath, owner, isRootMode || undefined).then((cached) => {
      if (cancelled || !cached) return;
      setContent(cached.content);
      setLoading(false);
    }).catch(() => {});

    // 2. Fetch from network
    const ownerParam = owner ? `&owner=${encodeURIComponent(owner)}` : '';
    const rootParam = isRootMode ? '&root=true' : '';
    authFetch(`/api/file/read?path=${encodeURIComponent(filePath)}${ownerParam}${rootParam}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) throw new Error(`加载失败: ${res.status}`);
        const data = (await res.json()) as { content: string };
        setContent(data.content);
        // Write to cache (fire-and-forget)
        textContentCache.set(filePath, data.content, Date.now(), owner, isRootMode || undefined).catch(() => {});
      })
      .catch((err) => {
        if (cancelled) return;
        // Only set error if we don't have cached content already shown
        setContent((prev) => {
          if (prev === null) {
            setError((err as Error).message || '加载失败');
          }
          return prev;
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [filePath, owner, isRootMode]);

  // 当前文件所在目录，用于解析相对路径链接
  const baseDir = filePath ? filePath.replace(/\/[^/]*$/, '') : '';

  const rules = useMemo(() => createMarkdownRules({
    colors,
    typo,
    owner,
    selectable: true,
    onPreviewMd: (path) => {
      // 绝对路径直接用；相对路径基于当前文件目录拼接
      const resolved = path.startsWith('/') ? path
        : baseDir ? `${baseDir}/${path.replace(/^\.\//, '')}` : path;
      router.push({ pathname: '/chat/markdown-preview', params: { filePath: resolved, ...(owner ? { owner } : {}), ...(isRootMode ? { root: 'true' } : {}) } });
    },
    onImagePress: (uri) => setLightboxUri(uri),
  }), [colors, typo, router, owner, baseDir, isRootMode]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{
        title: fileName,
        headerLeft: () => <BackButton />,
        unstable_headerLeftItems: () => [glassFree(
          <BackButton />
        )],
        headerRight: () => (
          <Pressable ref={headerMenuTriggerRef} onPress={handleOpenHeaderMenu} hitSlop={8}>
            <MoreHorizontal size={22} color={colors.foreground} strokeWidth={2} />
          </Pressable>
        ),
        unstable_headerRightItems: () => [glassFree(
          <Pressable ref={headerMenuTriggerRef} onPress={handleOpenHeaderMenu} hitSlop={8}>
            <MoreHorizontal size={22} color={colors.foreground} strokeWidth={2} />
          </Pressable>
        )],
      }} />

      {loading && (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      )}

      {error && (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {!loading && !error && content !== null && (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + spacing.md }]}
        >
          <Markdown style={mdStyles} rules={rules}>{content}</Markdown>
          {lightboxUri && (
            <ImageLightbox visible uri={lightboxUri} onClose={() => setLightboxUri(null)} />
          )}
        </ScrollView>
      )}

      {/* Header dropdown menu */}
      <DropdownMenu
        visible={headerMenuVisible}
        onClose={() => setHeaderMenuVisible(false)}
        sections={menuSections}
        onSelect={handleMenuSelect}
        anchorTop={headerMenuAnchor}
        align="right"
      />
    </View>
  );
}
