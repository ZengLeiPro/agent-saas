/**
 * Chat md+ right-slot Artifact body (no HTML/WebView).
 * Mirrors web ArtifactPreviewPanel for native-safe kinds; html stays download-notice.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import Markdown from 'react-native-markdown-display';
import {
  ARTIFACT_TEXT_MAX_BYTES,
  authFetchResource,
  formatFileSize,
  type ArtifactReadGrant,
} from '@agent/shared';
import { Button, EmptyState } from '../ui';
import { EntityIcons } from '../../lib/icons';
import { cjkMarkdownIt } from '../../lib/markdownIt';
import {
  fetchMobileArtifactGrant,
  MobileArtifactReadError,
  mobileArtifactWarning,
  selectMobileArtifactViewer,
} from '../../lib/artifactViewAdapter';
import { resolveArtifactRightSlotKind } from '../../lib/artifactRightSlot';
import { openOrShareUrl } from '../../utils/openOrShareFile';
import { createMarkdownRules } from './markdownRules';
import { createMarkdownStyles } from './markdownStyles';
import { useColors, spacing, fontScale, monoFamily } from '../../theme';

export type ArtifactPreviewPaneProps = {
  artifactId: string;
  fileName: string;
  fileSize?: number;
};

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; grant: ArtifactReadGrant; text?: string; truncated?: boolean };

export function ArtifactPreviewPane({ artifactId, fileName, fileSize }: ArtifactPreviewPaneProps) {
  const colors = useColors();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [opening, setOpening] = useState(false);
  const mdStyles = useMemo(() => createMarkdownStyles(colors), [colors]);
  const mdRules = useMemo(() => createMarkdownRules({ colors, selectable: true }), [colors]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const grant = await fetchMobileArtifactGrant(artifactId);
        if (cancelled) return;
        const kind = resolveArtifactRightSlotKind(selectMobileArtifactViewer(grant));
        if (kind === 'text') {
          const headers: Record<string, string> = {
            'X-Artifact-Correlation-Id': grant.descriptor.correlationId,
            Range: `bytes=0-${ARTIFACT_TEXT_MAX_BYTES - 1}`,
          };
          const response = await authFetchResource(grant.readUrl, {
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            headers,
          });
          if (!response.ok) {
            throw new MobileArtifactReadError(
              response.status,
              undefined,
              `加载失败（HTTP ${response.status}）`,
            );
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.includes(0)) {
            throw new Error('文本预览编码不安全');
          }
          const truncated =
            grant.descriptor.size > ARTIFACT_TEXT_MAX_BYTES ||
            bytes.byteLength >= ARTIFACT_TEXT_MAX_BYTES;
          const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
          if (cancelled) return;
          setState({ status: 'ready', grant, text, truncated });
          return;
        }
        setState({ status: 'ready', grant });
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof MobileArtifactReadError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Artifact 暂时无法打开';
        setState({ status: 'error', message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  const openSystem = useCallback(
    async (grant: ArtifactReadGrant, forceDownload = false) => {
      setOpening(true);
      try {
        let next = grant;
        if (forceDownload || grant.descriptor.requiresWarning) {
          next = await fetchMobileArtifactGrant(artifactId, true);
        }
        await openOrShareUrl(next.readUrl, next.descriptor.name || fileName);
      } catch (err) {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : '打开失败，请稍后重试',
        });
      } finally {
        setOpening(false);
      }
    },
    [artifactId, fileName],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        center: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacing.lg,
          gap: spacing.md,
        },
        textScroll: { flex: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
        mono: {
          ...fontScale.sm,
          fontFamily: monoFamily,
          color: colors.foreground,
        },
        truncated: {
          ...fontScale.xs,
          color: colors.mutedForeground,
          marginBottom: spacing.sm,
        },
        image: { width: '100%', height: '100%' },
        imageWrap: { flex: 1, backgroundColor: colors.muted },
      }),
    [colors],
  );

  if (state.status === 'loading') {
    return (
      <View style={styles.center} testID="artifact-preview-loading">
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (state.status === 'error') {
    return (
      <View style={styles.center} testID="artifact-preview-error">
        <EmptyState icon={EntityIcons.files} title="无法预览" description={state.message} />
      </View>
    );
  }

  const { grant, text, truncated } = state;
  const viewer = selectMobileArtifactViewer(grant);
  const kind = resolveArtifactRightSlotKind(viewer);
  const displayName = grant.descriptor.name || fileName;
  const size = grant.descriptor.size || fileSize;

  if (kind === 'download-notice') {
    const isHtmlish = grant.descriptor.viewKind === 'html';
    return (
      <View style={styles.center} testID="artifact-preview-download">
        <EmptyState
          icon={EntityIcons.files}
          title={displayName}
          description={[
            size ? formatFileSize(size) : null,
            isHtmlish
              ? '此文件包含主动内容（HTML），移动端不在应用内渲染。请下载后用可信原生应用打开。'
              : mobileArtifactWarning(grant),
          ]
            .filter(Boolean)
            .join('\n\n')}
        />
        <Button
          label={opening ? '准备中…' : '下载 / 分享'}
          onPress={() => {
            void openSystem(grant, true);
          }}
          variant="primary"
          size="md"
          disabled={opening}
        />
      </View>
    );
  }

  if (kind === 'text') {
    const isMarkdown = grant.descriptor.viewKind === 'markdown';
    return (
      <ScrollView
        style={styles.textScroll}
        contentContainerStyle={{ paddingBottom: spacing.xl }}
        testID="artifact-preview-text"
      >
        {truncated ? (
          <Text style={styles.truncated}>
            已截断至约 {formatFileSize(ARTIFACT_TEXT_MAX_BYTES)} 预览
          </Text>
        ) : null}
        {isMarkdown ? (
          <Markdown markdownit={cjkMarkdownIt} style={mdStyles} rules={mdRules}>
            {text || ''}
          </Markdown>
        ) : (
          <Text selectable style={styles.mono}>
            {text || ''}
          </Text>
        )}
      </ScrollView>
    );
  }

  if (kind === 'image') {
    return (
      <View style={styles.imageWrap} testID="artifact-preview-image">
        <Image
          source={{ uri: grant.readUrl }}
          style={styles.image}
          contentFit="contain"
          accessibilityLabel={displayName}
        />
      </View>
    );
  }

  // pdf / audio / video — system viewer from the right slot (no in-app HTML).
  return (
    <View style={styles.center} testID="artifact-preview-system">
      <EmptyState
        icon={EntityIcons.files}
        title={displayName}
        description={[
          size ? formatFileSize(size) : null,
          grant.descriptor.requiresWarning
            ? mobileArtifactWarning(grant)
            : '在系统应用中打开此 Artifact',
        ]
          .filter(Boolean)
          .join('\n\n')}
      />
      <Button
        label={opening ? '准备中…' : '打开 / 分享'}
        onPress={() => {
          void openSystem(grant, grant.descriptor.requiresWarning);
        }}
        variant="primary"
        size="md"
        disabled={opening}
      />
    </View>
  );
}
