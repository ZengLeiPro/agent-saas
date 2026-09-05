/**
 * 回收站底部面板 —— 对齐 Web `web/src/components/chat/TrashView.tsx`。
 *
 * 契约（与 Web 同源）：
 * - `GET  /api/sessions/trash`                列出已删除会话
 * - `POST /api/sessions/:id/restore`          恢复
 * - `DELETE /api/sessions/:id/permanent`      彻底删除单条
 * - `DELETE /api/sessions/trash`              全部清空
 *
 * 破坏性操作一律走 `showActionMenu` 二次确认，文案与 Web Dialog 一致。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ApiSessionListItem } from '@agent/shared';
import { authFetch, formatShortDate } from '@agent/shared';
import { BottomSheet, Button, EmptyState, ListRow, ListRowGroup, showActionMenu } from '../ui';
import { EntityIcons, ActionIcons } from '../../lib/icons';
import { hapticSuccess, hapticWarning } from '../../lib/haptics';
import { useColors, spacing, typography } from '../../theme';

export interface TrashSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 彻底删除或恢复后回调，用于刷新主列表 */
  onChanged?: () => void;
}

export function TrashSheet({ visible, onClose, onChanged }: TrashSheetProps) {
  const colors = useColors();
  const [sessions, setSessions] = useState<ApiSessionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        body: {
          maxHeight: 420,
        },
        center: {
          paddingVertical: spacing['3xl'],
          alignItems: 'center',
        },
        error: {
          ...typography.caption,
          color: colors.destructive,
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.sm,
        },
        footer: {
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.sm,
        },
      }),
    [colors],
  );

  const loadTrash = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch('/api/sessions/trash');
      if (!res.ok) throw new Error(`加载回收站失败 (${res.status})`);
      const data = (await res.json()) as { sessions?: ApiSessionListItem[] };
      setSessions(data.sessions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载回收站失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) void loadTrash();
  }, [visible, loadTrash]);

  const handleRestore = useCallback(
    async (sessionId: string) => {
      setBusyId(sessionId);
      try {
        const res = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
          method: 'POST',
        });
        if (!res.ok) throw new Error('恢复失败');
        setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
        hapticSuccess();
        onChanged?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : '恢复失败');
      } finally {
        setBusyId(null);
      }
    },
    [onChanged],
  );

  const handlePermanentDelete = useCallback(
    (sessionId: string) => {
      hapticWarning();
      showActionMenu({
        title: '永久删除',
        message: '确定要永久删除这个会话吗？此操作不可恢复。',
        actions: [
          {
            label: '永久删除',
            destructive: true,
            onPress: () => {
              void (async () => {
                setBusyId(sessionId);
                try {
                  const res = await authFetch(
                    `/api/sessions/${encodeURIComponent(sessionId)}/permanent`,
                    { method: 'DELETE' },
                  );
                  if (!res.ok) throw new Error('删除失败');
                  setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
                  onChanged?.();
                } catch (err) {
                  setError(err instanceof Error ? err.message : '删除失败');
                } finally {
                  setBusyId(null);
                }
              })();
            },
          },
        ],
      });
    },
    [onChanged],
  );

  const handleClearAll = useCallback(() => {
    if (sessions.length === 0) return;
    hapticWarning();
    showActionMenu({
      title: '清空回收站',
      message: `确定要永久删除回收站中的 ${sessions.length} 个会话吗？此操作不可恢复。`,
      actions: [
        {
          label: '确认清空',
          destructive: true,
          onPress: () => {
            void (async () => {
              setLoading(true);
              try {
                const res = await authFetch('/api/sessions/trash', { method: 'DELETE' });
                if (!res.ok) throw new Error('清空失败');
                setSessions([]);
                onChanged?.();
              } catch (err) {
                setError(err instanceof Error ? err.message : '清空失败');
                await loadTrash();
              } finally {
                setLoading(false);
              }
            })();
          },
        },
      ],
    });
  }, [sessions.length, loadTrash, onChanged]);

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="回收站"
      snap="half"
      testID="trash-sheet"
    >
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={EntityIcons.trash}
          title="回收站为空"
          description="删除的会话会先留在这里，可随时恢复。"
        />
      ) : (
        <ScrollView style={styles.body}>
          <ListRowGroup testID="trash-session-list">
            {sessions.map((session) => (
              <ListRow
                key={session.sessionId}
                title={session.title || '无标题'}
                subtitle={
                  session.deletedAt
                    ? formatShortDate(new Date(session.deletedAt).getTime())
                    : session.preview
                }
                disabled={busyId === session.sessionId}
                accessory={
                  <View style={{ flexDirection: 'row', gap: spacing.xs }}>
                    <Button
                      label="恢复"
                      variant="ghost"
                      size="sm"
                      icon={ActionIcons.undo}
                      disabled={busyId === session.sessionId}
                      onPress={() => void handleRestore(session.sessionId)}
                    />
                    <Button
                      label="删除"
                      variant="ghost"
                      size="sm"
                      disabled={busyId === session.sessionId}
                      onPress={() => handlePermanentDelete(session.sessionId)}
                    />
                  </View>
                }
              />
            ))}
          </ListRowGroup>
        </ScrollView>
      )}
      <View style={styles.footer}>
        <Button
          label="全部清空"
          variant="destructive"
          fullWidth
          disabled={loading || sessions.length === 0 || busyId !== null}
          onPress={handleClearAll}
        />
      </View>
    </BottomSheet>
  );
}
