/** 系统时间线块：runtime_status / system_event / system-error，以及内容审核提示。 */
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import type { MessageItem, RawPresentationGate } from '@agent/shared';
import { selectErrorPresentation, selectRenderModel } from '@agent/shared';
import { useColors, spacing, typography } from '../../../theme';

export function SystemTimelineMessage({
  message,
  gate,
  onRetry,
}: {
  message: Extract<MessageItem, { type: 'runtime_status' | 'system_event' | 'system-error' }>;
  gate?: RawPresentationGate;
  onRetry?: (message: MessageItem) => void;
}) {
  const colors = useColors();
  if (message.type === 'system-error') {
    const item = selectRenderModel({ messages: [message] }).items[0];
    const presentation = selectErrorPresentation(item, gate);
    const recovery = presentation.recoveryAction;
    return (
      <View
        accessibilityRole={presentation.tone === 'danger' ? 'alert' : 'summary'}
        accessibilityLabel={[
          presentation.title,
          presentation.statusLabel,
          presentation.summary,
          recovery?.label,
        ]
          .filter(Boolean)
          .join('，')}
        accessibilityLiveRegion={presentation.tone === 'danger' ? 'assertive' : 'polite'}
        style={{
          paddingVertical: spacing.sm,
          paddingHorizontal: spacing.sm,
          borderLeftWidth: 2,
          borderLeftColor: presentation.tone === 'danger' ? colors.destructive : colors.border,
        }}
      >
        <Text
          style={{
            ...typography.bodySmall,
            fontWeight: '600',
            color: presentation.tone === 'danger' ? colors.destructive : colors.foreground,
          }}
        >
          {presentation.title}
        </Text>
        <Text style={{ ...typography.bodySmall, color: colors.mutedForeground }}>
          {presentation.summary ?? presentation.statusLabel}
        </Text>
        {presentation.showRaw && presentation.summary !== message.content ? (
          <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
            {message.content}
          </Text>
        ) : null}
        {recovery?.kind === 'retry' && onRetry ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${presentation.title}，${recovery.label}`}
            onPress={() => onRetry(message)}
            style={{
              minHeight: 44,
              justifyContent: 'center',
              alignSelf: 'flex-start',
              paddingHorizontal: spacing.sm,
            }}
          >
            <Text style={{ ...typography.bodySmall, fontWeight: '600', color: colors.foreground }}>
              {recovery.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  const text =
    message.type === 'runtime_status'
      ? (message.content ?? message.status)
      : `${message.title}：${message.content}`;
  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel={`运行状态：${text}`}
      accessibilityLiveRegion="polite"
      style={{
        paddingVertical: spacing.xs,
        paddingHorizontal: spacing.sm,
        borderLeftWidth: 2,
        borderLeftColor: colors.border,
      }}
    >
      <Text style={{ ...typography.bodySmall, color: colors.mutedForeground }}>{text}</Text>
    </View>
  );
}

export function ModerationMessage({ message }: { message: MessageItem & { type: 'text' } }) {
  const colors = useColors();
  const outcome = message.moderation?.outcome ?? 'flagged';
  const text = outcome === 'blocked' ? '内容已被安全策略拦截' : '内容已标记，等待审核';
  return (
    <View
      accessibilityRole={outcome === 'blocked' ? 'alert' : 'summary'}
      accessibilityLabel={text}
      accessibilityLiveRegion={outcome === 'blocked' ? 'assertive' : 'polite'}
      style={{ paddingVertical: spacing.xs, paddingHorizontal: spacing.sm }}
    >
      <Text
        style={{
          ...typography.bodySmall,
          color: outcome === 'blocked' ? colors.destructive : colors.mutedForeground,
        }}
      >
        {text}
      </Text>
    </View>
  );
}
