/**
 * 插话队列条（对齐 `web/src/components/QueuedMessageBar.tsx`）。
 *
 * 运行中发送的消息不进时间线，在输入框上方排队展示；被目标 run 消费或回退接管时
 * 由服务端队列投影移除。条目可单条撤回（走既有 `cancel_queued`），
 * 终态条目（已撤销 / 发送失败）可本地移除。
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import ReAnimated from 'react-native-reanimated';
import { Clock, Loader2, X } from 'lucide-react-native';
import { queuedMessageBarTitle, type QueuedMessageEntry } from '@agent/shared';
import { useColors, spacing, radius, useChatTypography } from '../../theme';
import { ICON_SIZE, ICON_STROKE } from '../../lib/icons';
import { useSpinStyle } from '../ui';
import { useQueuedMessages } from '../../hooks/useQueuedMessages';

function QueuedRow({
  entry,
  index,
  busy,
  onCancel,
  onDismiss,
}: {
  entry: QueuedMessageEntry;
  index: number;
  busy: boolean;
  onCancel: (entry: QueuedMessageEntry) => void;
  onDismiss: (clientMsgId: string) => void;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const spin = useSpinStyle(busy);
  const removable = entry.settled;
  const actionable = removable || entry.cancellable;

  return (
    <View
      testID={`queue-item-${index}`}
      accessibilityLabel={`${entry.content}，${entry.statusLabel}`}
      style={[
        styles.row,
        {
          borderColor: colors.border,
          backgroundColor: colors.muted,
        },
        entry.settled ? styles.settled : null,
      ]}
    >
      {busy ? (
        <ReAnimated.View style={spin}>
          <Loader2
            size={ICON_SIZE.inline}
            color={colors.mutedForeground}
            strokeWidth={ICON_STROKE.default}
          />
        </ReAnimated.View>
      ) : (
        <Clock
          size={ICON_SIZE.inline}
          color={colors.mutedForeground}
          strokeWidth={ICON_STROKE.default}
        />
      )}
      <View style={styles.body}>
        <Text numberOfLines={1} style={[typo.bodySmall, { color: colors.foreground }]}>
          {entry.content}
          {entry.attachmentCount > 0 ? `（${entry.attachmentCount} 个附件）` : ''}
        </Text>
        <Text numberOfLines={1} style={[typo.caption, { color: colors.mutedForeground }]}>
          {entry.cancelling ? '撤回中…' : entry.statusLabel}
        </Text>
      </View>
      {actionable ? (
        <Pressable
          testID={`queue-cancel-${index}`}
          accessibilityRole="button"
          accessibilityLabel={removable ? `移除 ${entry.content}` : `撤回 ${entry.content}`}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => (removable ? onDismiss(entry.clientMsgId) : onCancel(entry))}
          style={[styles.action, busy ? styles.actionDisabled : null]}
        >
          <X
            size={ICON_SIZE.inline}
            color={colors.mutedForeground}
            strokeWidth={ICON_STROKE.default}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

export function QueuedMessageBar() {
  const colors = useColors();
  const typo = useChatTypography();
  const { entries, busyClientMsgId, cancel, dismiss } = useQueuedMessages();
  if (entries.length === 0) return null;

  return (
    <View testID="queued-message-bar" style={styles.bar}>
      <Text style={[typo.caption, { color: colors.mutedForeground }]}>
        {queuedMessageBarTitle(entries)}
      </Text>
      {entries.map((entry, index) => (
        <QueuedRow
          key={entry.clientMsgId}
          entry={entry}
          index={index}
          busy={busyClientMsgId === entry.clientMsgId || entry.cancelling}
          onCancel={(target) => {
            void cancel(target);
          }}
          onDismiss={dismiss}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  settled: {
    opacity: 0.7,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  action: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionDisabled: {
    opacity: 0.4,
  },
});
