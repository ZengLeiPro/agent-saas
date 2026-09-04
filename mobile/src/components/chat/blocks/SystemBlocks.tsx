/**
 * 系统时间线块：runtime_status / system_event / system-error，以及内容审核提示。
 *
 * runtime_status 的中文标签、图标语义位与语气全部取自 `@agent/shared` 的
 * `getRuntimeStatusMeta` / `getRuntimeStatusTone`（与 Web RuntimeStatusBlock 同源），
 * 不再把裸状态串（`waiting_hand`）直接打到屏幕上。
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Clock, Loader2, Server, Shield, User } from 'lucide-react-native';
import Animated from 'react-native-reanimated';
import type { MessageItem, RawPresentationGate, RuntimeStatusIcon } from '@agent/shared';
import {
  getRuntimeStatusMeta,
  getRuntimeStatusTone,
  selectErrorPresentation,
  selectRenderModel,
} from '@agent/shared';
import { useColors, spacing, radius, fontWeight, useChatTypography } from '../../../theme';
import { useSpinStyle } from '../../ui';
import { resolveActivityToneTokens } from './tone';

const ICON_BY_KEY: Record<RuntimeStatusIcon, typeof Clock> = {
  loader: Loader2,
  clock: Clock,
  server: Server,
  shield: Shield,
  user: User,
};

const ICON_SIZE = 14;

function RuntimeStatusRow({
  message,
}: {
  message: Extract<MessageItem, { type: 'runtime_status' }>;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const meta = getRuntimeStatusMeta(message.status);
  // running 刻意压成中性：思考是常态，不该长期占用一个高亮色位。
  const tone = resolveActivityToneTokens(
    message.status === 'running' ? 'neutral' : getRuntimeStatusTone(message.status),
    colors,
  );
  const Icon = ICON_BY_KEY[meta.icon];
  const spin = useSpinStyle(meta.icon === 'loader');
  const glyph = <Icon size={ICON_SIZE} color={tone.tint} strokeWidth={2} />;
  const text = message.content || meta.label;

  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel={`运行状态：${text}`}
      accessibilityLiveRegion="polite"
      style={styles.statusRow}
    >
      {meta.icon === 'loader' ? <Animated.View style={spin}>{glyph}</Animated.View> : glyph}
      <Text numberOfLines={1} style={[typo.bodySmall, styles.flexText, { color: tone.ink }]}>
        {text}
      </Text>
    </View>
  );
}

function SystemErrorBanner({
  message,
  gate,
  onRetry,
}: {
  message: Extract<MessageItem, { type: 'system-error' }>;
  gate?: RawPresentationGate;
  onRetry?: (message: MessageItem) => void;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const item = selectRenderModel({ messages: [message] }).items[0];
  const presentation = selectErrorPresentation(item, gate);
  const danger = presentation.tone === 'danger';
  const tone = resolveActivityToneTokens(danger ? 'danger' : 'neutral', colors);
  const recovery = presentation.recoveryAction;

  return (
    <View
      accessibilityRole={danger ? 'alert' : 'summary'}
      accessibilityLabel={[
        presentation.title,
        presentation.statusLabel,
        presentation.summary,
        recovery?.label,
      ]
        .filter(Boolean)
        .join('，')}
      accessibilityLiveRegion={danger ? 'assertive' : 'polite'}
      style={[
        styles.banner,
        {
          backgroundColor: danger ? tone.subtle : colors.muted,
          borderLeftColor: danger ? tone.tint : colors.border,
        },
      ]}
    >
      <Text
        style={[
          typo.bodySmall,
          { color: danger ? tone.ink : colors.foreground, fontWeight: fontWeight.semibold },
        ]}
      >
        {presentation.title}
      </Text>
      <Text style={[typo.bodySmall, { color: danger ? tone.ink : colors.mutedForeground }]}>
        {presentation.summary ?? presentation.statusLabel}
      </Text>
      {presentation.showRaw && presentation.summary !== message.content ? (
        <Text style={[typo.caption, { color: colors.mutedForeground }]}>{message.content}</Text>
      ) : null}
      {recovery?.kind === 'retry' && onRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${presentation.title}，${recovery.label}`}
          onPress={() => onRetry(message)}
          style={styles.recovery}
        >
          <Text
            style={[typo.bodySmall, { color: colors.foreground, fontWeight: fontWeight.semibold }]}
          >
            {recovery.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

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
  const typo = useChatTypography();

  if (message.type === 'system-error') {
    return <SystemErrorBanner message={message} gate={gate} onRetry={onRetry} />;
  }
  if (message.type === 'runtime_status') return <RuntimeStatusRow message={message} />;

  const text = `${message.title}：${message.content}`;
  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel={text}
      accessibilityLiveRegion="polite"
      style={[styles.systemEvent, { borderLeftColor: colors.border }]}
    >
      <Text style={[typo.bodySmall, { color: colors.mutedForeground }]}>{text}</Text>
    </View>
  );
}

export function ModerationMessage({ message }: { message: MessageItem & { type: 'text' } }) {
  const colors = useColors();
  const typo = useChatTypography();
  const outcome = message.moderation?.outcome ?? 'flagged';
  const blocked = outcome === 'blocked';
  const tone = resolveActivityToneTokens(blocked ? 'danger' : 'warning', colors);
  const text = blocked ? '内容已被安全策略拦截' : '内容已标记，等待审核';
  return (
    <View
      accessibilityRole={blocked ? 'alert' : 'summary'}
      accessibilityLabel={text}
      accessibilityLiveRegion={blocked ? 'assertive' : 'polite'}
      style={[styles.banner, { backgroundColor: tone.subtle, borderLeftColor: tone.tint }]}
    >
      <Text style={[typo.bodySmall, { color: tone.ink }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
  },
  flexText: { flex: 1, minWidth: 0 },
  banner: {
    gap: 2,
    borderLeftWidth: 2,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  systemEvent: {
    borderLeftWidth: 2,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  recovery: {
    minHeight: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
  },
});
