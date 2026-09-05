/**
 * 引用溯源角标（[CITE] 标记渲染产物），对齐 web `CitationCard` /
 * `MessageCitationCard` / `ContextCitationCard` 三件套：
 *
 * - 文档引用 `{ doc, page?, label }`：点角标直接打开文档——Markdown 走会话内
 *   markdown-preview 路由，其余走 useFileOpen（与文件浏览器同一条下载/分享链路）。
 * - Context 引用 `{ contextId, label }`：点角标拉取证据并打开 ContextCitationSheet；
 *   sessionId 只取自当前会话上下文，绝不读 marker payload 里的身份字段。
 *
 * 解析与归一化全部在 shared（splitByMessageMarkers / normalizeContextCitationDetail），
 * 本文件只做角标样式、跳转与请求编排。
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { BookOpen } from 'lucide-react-native';
import {
  authFetch,
  contextCitationError,
  contextCitationPath,
  getPreviewFileType,
  normalizeContextCitationDetail,
  type CitationSegment,
  type ContextCitationDetail,
} from '@agent/shared';
import { useChatAppState } from '../../../contexts/ChatAppStateContext';
import { useFileOpen } from '../../../hooks/useFileOpen';
import { useColors, useChatTypography, spacing, radius } from '../../../theme';
import type { ThemeColors } from '../../../theme';
import { ContextCitationSheet } from './ContextCitationSheet';

function useCitationStyles(colors: ThemeColors, typo: ReturnType<typeof useChatTypography>) {
  return useMemo(
    () =>
      StyleSheet.create({
        badge: {
          alignSelf: 'flex-start',
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.xs + 2,
          maxWidth: '100%',
          marginVertical: spacing.xs,
          paddingHorizontal: spacing.sm + 2,
          paddingVertical: spacing.xs,
          borderRadius: radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          backgroundColor: colors.muted,
        },
        disabled: { opacity: 0.6 },
        label: { ...typo.caption, color: colors.foreground, flexShrink: 1 },
        page: {
          ...typo.meta,
          color: colors.brand[600],
          paddingHorizontal: spacing.xs,
          paddingVertical: 1,
          borderRadius: radius.sm,
          backgroundColor: colors.brand[50],
          overflow: 'hidden',
        },
      }),
    [colors, typo],
  );
}

function CitationBadge({
  label,
  page,
  disabled,
  accessibilityLabel,
  onPress,
  testID,
}: {
  label: string;
  page?: number;
  disabled?: boolean;
  accessibilityLabel: string;
  onPress: () => void;
  testID?: string;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useCitationStyles(colors, typo);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.badge, disabled ? styles.disabled : null]}
    >
      <BookOpen size={14} color={colors.brand[600]} strokeWidth={2} />
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {page ? <Text style={styles.page}>p.{page}</Text> : null}
    </Pressable>
  );
}

/** 文档引用：Markdown 走会话内预览，其余交给 useFileOpen 下载/分享 */
function DocumentCitationCard({
  doc,
  page,
  label,
  owner,
}: {
  doc: string;
  page?: number;
  label: string;
  owner?: string;
}) {
  const router = useRouter();
  const { open, downloading } = useFileOpen();

  const handlePress = useCallback(() => {
    if (getPreviewFileType(doc) === 'md') {
      router.push({
        pathname: '/chat/markdown-preview',
        params: { filePath: doc, ...(owner ? { owner } : {}) },
      });
      return;
    }
    void open({ path: doc, modifiedAt: 0, size: 0, ...(owner ? { owner } : {}) });
  }, [doc, owner, open, router]);

  return (
    <CitationBadge
      testID="citation-card"
      label={label}
      {...(page ? { page } : {})}
      disabled={downloading}
      accessibilityLabel={`引用：${label}`}
      onPress={handlePress}
    />
  );
}

/** Context 引用：点开后拉取证据，失败可重试；未登录/无会话时角标禁用 */
function ContextCitationCard({ contextId, label }: { contextId: string; label: string }) {
  const { sessionId } = useChatAppState();
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContextCitationDetail | null>(null);
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    if (!sessionId) return;
    const currentRequest = ++requestVersion.current;
    setLoading(true);
    setError(null);
    setDetail(null);
    try {
      const response = await authFetch(contextCitationPath(sessionId, contextId), {
        method: 'GET',
      });
      if (!response.ok) throw new Error(contextCitationError(response.status));
      const normalized = normalizeContextCitationDetail(await response.json());
      if (!normalized) throw new Error('引用证据返回格式错误，请稍后重试。');
      if (requestVersion.current === currentRequest) setDetail(normalized);
    } catch (caught) {
      if (requestVersion.current === currentRequest) {
        setError(caught instanceof Error ? caught.message : '引用证据加载失败，请稍后重试。');
      }
    } finally {
      if (requestVersion.current === currentRequest) setLoading(false);
    }
  }, [contextId, sessionId]);

  const handleOpen = useCallback(() => {
    setVisible(true);
    void load();
  }, [load]);

  return (
    <View>
      <CitationBadge
        testID="context-citation-card"
        label={label}
        disabled={!sessionId}
        accessibilityLabel={`Context 引用：${label}`}
        onPress={handleOpen}
      />
      <ContextCitationSheet
        visible={visible}
        label={label}
        detail={detail}
        loading={loading}
        error={error}
        onClose={() => setVisible(false)}
        onRetry={() => {
          void load();
        }}
      />
    </View>
  );
}

/** [CITE] 段的统一入口：按 payload 形态分派到文档引用 / Context 引用 */
export function MessageCitationCard({
  citation,
  owner,
}: {
  citation: CitationSegment;
  owner?: string;
}) {
  return 'contextId' in citation ? (
    <ContextCitationCard contextId={citation.contextId} label={citation.label} />
  ) : (
    <DocumentCitationCard
      doc={citation.doc}
      {...(citation.page ? { page: citation.page } : {})}
      label={citation.label}
      {...(owner ? { owner } : {})}
    />
  );
}
