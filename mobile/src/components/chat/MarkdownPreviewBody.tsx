/**
 * Markdown file preview body — shared by `/chat/markdown-preview` stack route
 * and md+ chat right-slot overlay (no Stack.Screen chrome).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { fetchFileText } from '../../services/fileTextService';
import { textContentCache } from '../../services/textContentCache';
import { resolveKbPreviewSource } from '../../lib/filePreviewTarget';
import { cjkMarkdownIt } from '../../lib/markdownIt';
import { createMarkdownStyles } from './markdownStyles';
import { createMarkdownRules } from './markdownRules';
import { ImageLightbox } from './ImageLightbox';
import { useColors, spacing, typography, useChatTypography } from '../../theme';

export type MarkdownPreviewBodyProps = {
  filePath: string;
  owner?: string;
  root?: boolean;
  /** Nested md link navigation (absolute or relative to current file). */
  onNavigatePreview?: (filePath: string) => void;
};

export function MarkdownPreviewBody({
  filePath,
  owner,
  root,
  onNavigatePreview,
}: MarkdownPreviewBodyProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const typo = useChatTypography();
  const isRootMode = root === true;

  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);

  const docPath = filePath ? resolveKbPreviewSource(filePath).doc : '';
  const baseDir = docPath ? docPath.replace(/\/[^/]*$/, '') : '';

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.card },
        centered: {
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          gap: 12,
        },
        errorText: { ...typography.body, color: colors.mutedForeground },
        scrollView: { flex: 1 },
        scrollContent: {
          paddingHorizontal: 14,
          paddingTop: spacing.sm,
          paddingBottom: spacing.md,
        },
      }),
    [colors],
  );

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
    setContent(null);

    textContentCache
      .get(filePath, owner, isRootMode || undefined)
      .then((cached) => {
        if (cancelled || !cached) return;
        setContent(cached.content);
        setLoading(false);
      })
      .catch(() => {});

    fetchFileText(filePath, {
      ...(owner ? { owner } : {}),
      ...(isRootMode ? { root: true } : {}),
    })
      .then((fetched) => {
        if (cancelled) return;
        setContent(fetched);
        textContentCache.set(filePath, fetched, Date.now(), owner, isRootMode || undefined).catch(() => {});
      })
      .catch((err) => {
        if (cancelled) return;
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

    return () => {
      cancelled = true;
    };
  }, [filePath, owner, isRootMode]);

  const rules = useMemo(
    () =>
      createMarkdownRules({
        colors,
        typo,
        owner,
        selectable: true,
        onPreviewMd: (path) => {
          const resolved = path.startsWith('/')
            ? path
            : baseDir
              ? `${baseDir}/${path.replace(/^\.\//, '')}`
              : path;
          onNavigatePreview?.(resolved);
        },
        onImagePress: (uri) => setLightboxUri(uri),
      }),
    [colors, typo, owner, baseDir, onNavigatePreview],
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (content === null) return <View style={styles.container} />;

  return (
    <View style={styles.container} testID="markdown-preview-body">
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + spacing.md }]}
      >
        <Markdown markdownit={cjkMarkdownIt} style={mdStyles} rules={rules}>
          {content}
        </Markdown>
        {lightboxUri ? (
          <ImageLightbox visible uri={lightboxUri} onClose={() => setLightboxUri(null)} />
        ) : null}
      </ScrollView>
    </View>
  );
}

/** Display name for overlay / stack title. */
export function markdownPreviewTitle(filePath: string): string {
  const doc = resolveKbPreviewSource(filePath).doc;
  return doc.split('/').pop() || doc || '预览';
}
