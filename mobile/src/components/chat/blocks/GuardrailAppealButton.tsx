/**
 * 门禁拒答申诉入口（对齐 `web/src/components/GuardrailAppealButton.tsx`）。
 *
 * - 只在门禁拒答气泡（message.guardrailEventId 存在）下出现；
 *   MessageFeedbackContext 缺省时零渲染，与 Web 同一条兼容性红线。
 * - guardrailEventId 是服务端拒答链路落库的真实 event id（WS text 事件 /
 *   transcript assistant 行透传），不是 messageId。
 * - 幂等：服务端按 guardrail_event_id + user_id 唯一约束落库，
 *   重复提交 409 → UI 同样落到「已申诉」态（判定见 shared guardrailAppealOutcome）。
 * - 已申诉集合驻留在模块级 Set：同一进程内跨消息实例共享，避免复渲丢状态；
 *   冷启动重置，但服务端 409 会把 UI 拉回已申诉态。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Flag } from 'lucide-react-native';
import {
  GUARDRAIL_APPEAL_PATH,
  MESSAGE_FEEDBACK_COMMENT_MAX,
  authFetch,
  buildGuardrailAppealPayload,
  guardrailAppealFailureCopy,
  guardrailAppealOutcome,
} from '@agent/shared';
import { useMessageFeedback } from '../../../contexts/MessageFeedbackContext';
import { BottomSheet, Button, Input } from '../../ui';
import { useColors, useChatTypography, spacing, radius } from '../../../theme';

/** 已申诉的 guardrailEventId（跨消息实例共享） */
const submittedAppeals = new Set<string>();
const submittedListeners = new Set<() => void>();

function markSubmitted(id: string): void {
  submittedAppeals.add(id);
  for (const listener of submittedListeners) listener();
}

function useSubmittedAppeal(id: string): boolean {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const listener = () => forceRender((value) => value + 1);
    submittedListeners.add(listener);
    return () => {
      submittedListeners.delete(listener);
    };
  }, []);
  return submittedAppeals.has(id);
}

/** 测试钩子：清空模块级已申诉集合 */
export function __resetSubmittedAppealsForTest(): void {
  submittedAppeals.clear();
  submittedListeners.clear();
}

export interface GuardrailAppealButtonProps {
  /** 拒答链路落库的真实 guardrail event id（runtime_guardrail_events.id） */
  guardrailEventId: string;
}

export function GuardrailAppealButton({ guardrailEventId }: GuardrailAppealButtonProps) {
  const feedback = useMessageFeedback();
  const colors = useColors();
  const typo = useChatTypography();
  const submitted = useSubmittedAppeal(guardrailEventId);
  const [visible, setVisible] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        trigger: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.xs,
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs / 2,
          borderRadius: radius.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
        },
        triggerLabel: { ...typo.caption, color: colors.mutedForeground },
        doneRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.xs,
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs / 2,
          borderRadius: radius.md,
          backgroundColor: colors.successFamily.subtle,
        },
        doneLabel: { ...typo.caption, color: colors.successFamily.ink },
        sheetBody: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.md },
        hint: { ...typo.caption, color: colors.mutedForeground },
        error: { ...typo.caption, color: colors.dangerFamily.ink },
        actions: {
          flexDirection: 'row',
          justifyContent: 'flex-end',
          gap: spacing.sm,
          paddingBottom: spacing.sm,
        },
      }),
    [colors, typo],
  );

  if (!feedback) return null;

  if (submitted) {
    return (
      <View style={styles.doneRow} accessibilityRole="text" testID="guardrail-appeal-done">
        <Flag size={12} color={colors.successFamily.ink} strokeWidth={2} />
        <Text style={styles.doneLabel}>已申诉，管理员会看到并调整</Text>
      </View>
    );
  }

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await authFetch(GUARDRAIL_APPEAL_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildGuardrailAppealPayload({ guardrailEventId, appealReason: reason }),
        ),
      });
      const outcome = guardrailAppealOutcome(res.status);
      if (outcome === 'submitted') {
        markSubmitted(guardrailEventId);
        setVisible(false);
        setReason('');
        return;
      }
      setErrorMsg(guardrailAppealFailureCopy(outcome));
    } catch {
      setErrorMsg('网络错误，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Pressable
        testID="guardrail-appeal-button"
        accessibilityRole="button"
        accessibilityLabel="申诉：这个问题应该在专家范围内"
        hitSlop={8}
        onPress={() => setVisible(true)}
        style={styles.trigger}
      >
        <Flag size={12} color={colors.mutedForeground} strokeWidth={2} />
        <Text style={styles.triggerLabel}>这个应该在范围内</Text>
      </Pressable>
      <BottomSheet
        visible={visible}
        onClose={() => setVisible(false)}
        title="申诉：这个应该在专家范围内"
        testID="guardrail-appeal-sheet"
      >
        <View style={styles.sheetBody}>
          <Text style={styles.hint}>您认为为什么应该在范围内？（可选）</Text>
          <Input
            value={reason}
            onChangeText={setReason}
            multiline
            maxLength={MESSAGE_FEEDBACK_COMMENT_MAX}
            placeholder="补充说明（可选）"
            accessibilityLabel="申诉理由"
            testID="guardrail-appeal-input"
          />
          {errorMsg ? <Text style={styles.error}>{errorMsg}</Text> : null}
          <View style={styles.actions}>
            <Button
              label="取消"
              variant="ghost"
              size="sm"
              onPress={() => {
                setVisible(false);
                setReason('');
                setErrorMsg(null);
              }}
            />
            <Button
              label="提交申诉"
              size="sm"
              loading={submitting}
              onPress={() => {
                void handleSubmit();
              }}
              testID="guardrail-appeal-submit"
            />
          </View>
        </View>
      </BottomSheet>
    </>
  );
}
