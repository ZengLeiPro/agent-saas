/**
 * AskUser / 审批固定提示区（对齐 `web/src/components/AskUserPromptPanel.tsx`）。
 *
 * 纪律：
 * 1. 待办交互永远固定在输入框正上方，不混进时间线——用户不需要往回翻才发现「卡在等我」；
 * 2. 多条 pending 按服务端 FIFO 顺序可切换，显示「第 n/N 条」，而不是只提示排队数；
 * 3. 提交中禁用整块表单；M40-03 的 ACK 状态机在 `useChatAppState` 里，
 *    超时会释放提交锁并留下系统提示，这里同步把表单解禁并显式提示可重新提交。
 *
 * 表单体复用 `blocks/AskUserBlock.tsx` 与 `blocks/PermissionBlock.tsx`，
 * Maestro 依赖的 `ask-user-submit` / `permission-allow-button` testID 因此原样保留。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import type { AskUserAnswers, MessageItem } from '@agent/shared';
import { useColors, spacing, radius, useChatTypography, type ThemeColors } from '../../theme';
import { ICON_SIZE, ICON_STROKE } from '../../lib/icons';
import { AskUserBlock } from './blocks/AskUserBlock';
import { PermissionBlock } from './blocks/PermissionBlock';

type PendingInteraction = Extract<MessageItem, { type: 'ask_user' | 'permission_request' }>;

/** 与 `useChatAppState` 的 INTERACTION_RESPONSE_ACK_TIMEOUT_MS 对齐：ACK 超时即可重新提交。 */
const ACK_TIMEOUT_MS = 15_000;

/** 服务端 FIFO 顺序是唯一权威；客户端时间戳不参与排序。 */
function selectPendingInteractions(messages: readonly MessageItem[]): PendingInteraction[] {
  return messages
    .filter(
      (message): message is PendingInteraction =>
        (message.type === 'ask_user' || message.type === 'permission_request') &&
        message.status === 'pending',
    )
    .sort(
      (left, right) =>
        (left.interactionOrder ?? Number.MAX_SAFE_INTEGER) -
          (right.interactionOrder ?? Number.MAX_SAFE_INTEGER) ||
        (left.interactionVersion ?? 0) - (right.interactionVersion ?? 0) ||
        left.interactionId.localeCompare(right.interactionId),
    );
}

function NavButton({
  label,
  icon: Icon,
  disabled,
  onPress,
  testID,
  colors,
}: {
  label: string;
  icon: typeof ChevronLeft;
  disabled: boolean;
  onPress: () => void;
  testID: string;
  colors: ThemeColors;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.navButton, disabled ? styles.navButtonDisabled : null]}
    >
      <Icon
        size={ICON_SIZE.inline}
        color={disabled ? colors.mutedForeground : colors.foreground}
        strokeWidth={ICON_STROKE.default}
      />
    </Pressable>
  );
}

export function AskUserPromptPanel({
  messages,
  disabled = false,
  onAskUserResponse,
  onPermissionResponse,
}: {
  messages: readonly MessageItem[];
  /** 上层门禁（缺 Agent 目标等）：整块表单只读。 */
  disabled?: boolean;
  onAskUserResponse?: (interactionId: string, answers: AskUserAnswers) => Promise<void>;
  onPermissionResponse?: (interactionId: string, allow: boolean) => Promise<void>;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const pending = useMemo(() => selectPendingInteractions(messages), [messages]);
  const total = pending.length;

  const [activeIndex, setActiveIndex] = useState(0);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [ackTimedOutId, setAckTimedOutId] = useState<string | null>(null);
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAckTimer = useCallback(() => {
    if (ackTimerRef.current) {
      clearTimeout(ackTimerRef.current);
      ackTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearAckTimer, [clearAckTimer]);

  // 列表收缩（有交互被解决）时把游标夹回有效范围，避免停在空位上。
  useEffect(() => {
    setActiveIndex((index) => (index >= total ? Math.max(0, total - 1) : index));
  }, [total]);

  // 提交中的交互一旦离开 pending（服务端已确认），立刻释放提交态与超时提示。
  const pendingIds = useMemo(() => new Set(pending.map((item) => item.interactionId)), [pending]);
  useEffect(() => {
    if (submittingId && !pendingIds.has(submittingId)) {
      clearAckTimer();
      setSubmittingId(null);
    }
    if (ackTimedOutId && !pendingIds.has(ackTimedOutId)) setAckTimedOutId(null);
  }, [ackTimedOutId, clearAckTimer, pendingIds, submittingId]);

  const active = pending[Math.min(activeIndex, Math.max(0, total - 1))];

  const beginSubmit = useCallback(
    (interactionId: string) => {
      clearAckTimer();
      setAckTimedOutId(null);
      setSubmittingId(interactionId);
      // ACK 状态机在 hook 里释放提交锁；UI 同步解禁，让用户能立刻重新提交。
      ackTimerRef.current = setTimeout(() => {
        ackTimerRef.current = null;
        setSubmittingId((current) => (current === interactionId ? null : current));
        setAckTimedOutId(interactionId);
      }, ACK_TIMEOUT_MS);
    },
    [clearAckTimer],
  );

  const handleAskUser = useCallback(
    async (interactionId: string, answers: AskUserAnswers) => {
      if (!onAskUserResponse) return;
      beginSubmit(interactionId);
      await onAskUserResponse(interactionId, answers);
    },
    [beginSubmit, onAskUserResponse],
  );

  const handlePermission = useCallback(
    async (interactionId: string, allow: boolean) => {
      if (!onPermissionResponse) return;
      beginSubmit(interactionId);
      await onPermissionResponse(interactionId, allow);
    },
    [beginSubmit, onPermissionResponse],
  );

  if (!active) return null;

  const submitting = submittingId === active.interactionId;
  const formDisabled = disabled || submitting;
  const timedOut = ackTimedOutId === active.interactionId;

  return (
    <View
      style={[styles.zone, { borderColor: colors.border, backgroundColor: colors.card }]}
      accessibilityLabel={active.type === 'ask_user' ? '待回答问题' : '待处理权限请求'}
      testID="canonical-interaction-zone"
    >
      {total > 1 ? (
        <View style={styles.header}>
          <NavButton
            testID="interaction-prev"
            label="上一条"
            icon={ChevronLeft}
            colors={colors}
            disabled={submitting || activeIndex === 0}
            onPress={() => setActiveIndex((index) => Math.max(0, index - 1))}
          />
          <Text
            testID="interaction-counter"
            style={[typo.caption, styles.counter, { color: colors.mutedForeground }]}
          >
            第 {Math.min(activeIndex, total - 1) + 1}/{total} 条
          </Text>
          <NavButton
            testID="interaction-next"
            label="下一条"
            icon={ChevronRight}
            colors={colors}
            disabled={submitting || activeIndex >= total - 1}
            onPress={() => setActiveIndex((index) => Math.min(total - 1, index + 1))}
          />
        </View>
      ) : null}
      <ScrollView
        style={styles.interactionScroll}
        contentContainerStyle={styles.interactionScrollContent}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
      >
        {active.type === 'ask_user' ? (
          <AskUserBlock
            key={active.interactionId}
            message={active}
            disabled={formDisabled}
            onResponse={handleAskUser}
          />
        ) : (
          <PermissionBlock
            key={active.interactionId}
            message={active}
            disabled={formDisabled}
            onResponse={handlePermission}
          />
        )}
        {submitting ? (
          <Text
            testID="interaction-submitting"
            accessibilityLiveRegion="polite"
            style={[typo.caption, styles.notice, { color: colors.mutedForeground }]}
          >
            正在提交，等待服务端确认…
          </Text>
        ) : null}
        {timedOut ? (
          <Text
            testID="interaction-ack-timeout"
            accessibilityLiveRegion="polite"
            style={[typo.caption, styles.notice, { color: colors.mutedForeground }]}
          >
            等待服务端确认超时，请重新提交。
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  zone: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    maxHeight: 360,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  navButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navButtonDisabled: {
    opacity: 0.4,
  },
  counter: {
    minWidth: 64,
    textAlign: 'center',
  },
  interactionScroll: {
    flexShrink: 1,
  },
  interactionScrollContent: {
    flexGrow: 0,
    paddingBottom: spacing.xs,
  },
  notice: {
    marginTop: spacing.sm,
  },
});
