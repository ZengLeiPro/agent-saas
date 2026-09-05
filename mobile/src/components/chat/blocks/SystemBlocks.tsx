/**
 * 系统时间线块：runtime_status / system_event / system-error，以及内容审核提示。
 *
 * runtime_status 的中文标签、图标语义位与语气全部取自 `@agent/shared` 的
 * `getRuntimeStatusMeta` / `getRuntimeStatusTone`（与 Web RuntimeStatusBlock 同源），
 * 不再把裸状态串（`waiting_hand`）直接打到屏幕上。
 *
 * system-error 走 `selectErrorPresentation` + `selectClientFailureCopy`：
 * 前者决定语气与是否可看原文，后者决定客户面文案与唯一恢复动作——
 * 普通失败提示发送「继续」，策略拒绝/配额只提示切换模型，绝不互相串味。
 */
import React, { useCallback, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Clock, Loader2, Server, Shield, User } from 'lucide-react-native';
import Animated from 'react-native-reanimated';
import type {
  ClientFailureCopy,
  MessageItem,
  RawPresentationGate,
  RuntimeStatusIcon,
} from '@agent/shared';
import {
  getRuntimeStatusMeta,
  getRuntimeStatusTone,
  selectClientFailureCopy,
  selectErrorPresentation,
  selectRenderModel,
} from '@agent/shared';
import { useColors, spacing, radius, fontWeight, useChatTypography } from '../../../theme';
import { Button, useSpinStyle } from '../../ui';
import { useChatAppState } from '../../../contexts/ChatAppStateContext';
import { showActionMenu } from '../../../lib/prompt';
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

/**
 * 恢复动作按钮：一条失败至多一个动作（shared 已收敛），这里只负责接线。
 * 拿不到对应能力时不渲染按钮——不允许出现「点了没反应」的恢复入口。
 */
function RecoveryButton({
  copy,
  onRetry,
}: {
  copy: ClientFailureCopy;
  onRetry?: () => void;
}) {
  const { modelList, selectedModel, onModelChange } = useChatAppState();

  const openModelPicker = useCallback(() => {
    if (!modelList) return;
    showActionMenu({
      title: '切换模型',
      message: copy.hint ?? copy.message,
      actions: modelList.groups.flatMap((group) => group.models.map((model) => ({
        label: `${group.name} · ${model.name}`,
        disabled: `${group.id}/${model.id}` === selectedModel,
        onPress: () => onModelChange(`${group.id}/${model.id}`),
      }))),
    });
  }, [copy.hint, copy.message, modelList, onModelChange, selectedModel]);

  const action = copy.action;
  if (!action) return null;
  if (action.kind === 'retry') {
    return onRetry
      ? <Button variant="outline" size="sm" label={action.label} onPress={onRetry} />
      : null;
  }
  if (action.kind === 'switch_model') {
    return modelList
      ? <Button variant="outline" size="sm" label={action.label} onPress={openModelPicker} />
      : null;
  }
  return null;
}

function SystemErrorBanner({
  message,
  gate,
  isLoading,
  onRetry,
}: {
  message: Extract<MessageItem, { type: 'system-error' }>;
  gate?: RawPresentationGate;
  /** 运行中不提供恢复入口：这一轮还没结束（与 Web SystemErrorMessage 一致）。 */
  isLoading?: boolean;
  onRetry?: (message: MessageItem) => void;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const presentation = useMemo(
    () => selectErrorPresentation(selectRenderModel({ messages: [message] }).items[0], gate),
    [gate, message],
  );
  // 分类只读结构化字段（severity / failureKind / recoveryAction / canonicalFailure），不猜错误文本。
  const copy = useMemo(() => selectClientFailureCopy({
    presentation,
    ...(message.severity ? { severity: message.severity } : {}),
    ...(message.failureKind ? { failureKind: message.failureKind } : {}),
    ...(message.recoveryAction ? { recoveryAction: message.recoveryAction } : {}),
    ...(message.canonicalFailure ? { canonicalFailure: message.canonicalFailure } : {}),
    ...(message.quotaResetAt ? { resetAt: message.quotaResetAt } : {}),
  }), [message, presentation]);
  const danger = presentation.tone === 'danger';
  const tone = resolveActivityToneTokens(danger ? 'danger' : 'neutral', colors);

  return (
    <View
      accessibilityRole={danger ? 'alert' : 'summary'}
      accessibilityLabel={[copy.title, copy.message, copy.hint, copy.action?.label]
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
        {copy.title}
      </Text>
      <Text style={[typo.bodySmall, { color: danger ? tone.ink : colors.mutedForeground }]}>
        {copy.message}
      </Text>
      {copy.hint ? (
        <Text style={[typo.caption, { color: colors.mutedForeground }]}>{copy.hint}</Text>
      ) : null}
      {/* 原始终态文本只在 debugMode/RawPresentationGate 放行时露出，安全边界不变。 */}
      {presentation.showRaw && copy.message !== message.content ? (
        <Text style={[typo.caption, { color: colors.mutedForeground }]}>{message.content}</Text>
      ) : null}
      {isLoading ? null : (
        <View style={styles.recovery}>
          <RecoveryButton copy={copy} onRetry={onRetry ? () => onRetry(message) : undefined} />
        </View>
      )}
    </View>
  );
}

export function SystemTimelineMessage({
  message,
  gate,
  isLoading,
  onRetry,
}: {
  message: Extract<MessageItem, { type: 'runtime_status' | 'system_event' | 'system-error' }>;
  gate?: RawPresentationGate;
  isLoading?: boolean;
  onRetry?: (message: MessageItem) => void;
}) {
  const colors = useColors();
  const typo = useChatTypography();

  if (message.type === 'system-error') {
    return <SystemErrorBanner message={message} gate={gate} isLoading={isLoading} onRetry={onRetry} />;
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
    flexDirection: 'row',
    alignSelf: 'flex-start',
  },
});
