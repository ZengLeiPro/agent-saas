/**
 * 子任务完整过程（对齐 `web/src/components/SubagentTranscriptPanel.tsx`，
 * Web 在 MobileLayout 里用 SlidePanel 全屏覆盖，这里用全屏 Modal）。
 *
 * 取数与 Web 同一条：`GET /api/sessions/:childSessionId?silent=1` 拿
 * ApiSessionDetail；Web 直接铺 transcript blocks，移动端复用 MessageList
 * 渲染同一份 mapSessionDetailToMessages 产物，子会话与主会话的气泡口径一致
 * （呈现门禁、原始 payload 可见性同样由 RawPresentationGate/debugMode 决定）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import {
  authFetch,
  injectCompactionMessages,
  mapSessionDetailToMessages,
  type ApiSessionDetail,
  type MessageItem,
} from '@agent/shared';
import { MessageList } from './MessageList';
import { EmptyState } from '../ui';
import { useColors, useChatTypography, spacing } from '../../theme';

export interface SubagentTranscriptSheetProps {
  visible: boolean;
  childSessionId: string;
  /** 子任务类型，用于标题 */
  title: string;
  onClose: () => void;
}

export function SubagentTranscriptSheet({
  visible,
  childSessionId,
  title,
  onClose,
}: SubagentTranscriptSheetProps) {
  const colors = useColors();
  const typo = useChatTypography();
  const insets = useSafeAreaInsets();
  const [detail, setDetail] = useState<ApiSessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // MessageList 的滚动策略引用：子会话是只读回放，进来直接停在末尾。
  const shouldScrollRef = useRef(true);
  const isNearBottomRef = useRef(true);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setDetail(null);
    setError(null);
    shouldScrollRef.current = true;
    authFetch(`/api/sessions/${encodeURIComponent(childSessionId)}?silent=1`)
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `HTTP ${response.status}`);
        }
        return (await response.json()) as ApiSessionDetail;
      })
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [visible, childSessionId]);

  const messages = useMemo<MessageItem[]>(() => {
    if (!detail) return [];
    return injectCompactionMessages(
      detail.blocks,
      mapSessionDetailToMessages(detail, detail.owner?.username),
    );
  }, [detail]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.background },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          paddingTop: Platform.OS === 'android' ? insets.top + spacing.sm : spacing.sm,
          backgroundColor: colors.background,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        headerText: { flex: 1, minWidth: 0 },
        headerTitle: { ...typo.subtitle, color: colors.foreground },
        headerSubtitle: { ...typo.caption, color: colors.mutedForeground },
        closeButton: { padding: spacing.xs },
        center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
        hint: { ...typo.caption, color: colors.mutedForeground },
        errorBanner: {
          margin: spacing.md,
          padding: spacing.md,
          borderRadius: spacing.sm,
          backgroundColor: colors.dangerFamily.subtle,
        },
        errorText: { ...typo.bodySmall, color: colors.dangerFamily.ink },
      }),
    [colors, typo, insets.top],
  );

  const renderBody = useCallback(() => {
    if (error) {
      return (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>无法读取子任务记录：{error}</Text>
        </View>
      );
    }
    if (!detail) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="small" color={colors.mutedForeground} />
          <Text style={styles.hint}>正在读取子任务记录</Text>
        </View>
      );
    }
    return (
      <>
        {detail.lastRunState?.error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>终止原因：{detail.lastRunState.error}</Text>
          </View>
        ) : null}
        {messages.length === 0 ? (
          <EmptyState title="该子任务还没有可展示的记录。" />
        ) : (
          <MessageList
            messages={messages}
            loading={false}
            shouldScrollRef={shouldScrollRef}
            isNearBottomRef={isNearBottomRef}
          />
        )}
      </>
    );
  }, [colors.mutedForeground, detail, error, messages, styles]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
      onRequestClose={onClose}
      statusBarTranslucent={Platform.OS === 'android'}
    >
      <View style={styles.container} testID="subagent-transcript-sheet">
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              子任务完整过程 · {title}
            </Text>
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {childSessionId}
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            style={styles.closeButton}
            accessibilityRole="button"
            accessibilityLabel="关闭子任务完整过程"
          >
            <X size={24} color={colors.foreground} strokeWidth={2} />
          </Pressable>
        </View>
        {renderBody()}
      </View>
    </Modal>
  );
}
