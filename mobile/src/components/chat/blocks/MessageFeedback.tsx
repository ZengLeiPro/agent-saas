/**
 * 消息反馈按钮（对齐 `web/src/components/MessageFeedback.tsx`）。
 *
 * - MessageFeedbackContext 缺省（个人 Agent 会话 / 数据面 503）→ 零渲染，
 *   与 Web 同一条兼容性红线。
 * - 点「赞」直接提交 rating='up'（好评不需要理由）；点「踩」打开底部弹层填
 *   可选原因（≤500 字，上限来自 shared 契约）。
 * - 提交成功后对应按钮转实心并禁用，重载后由 Provider 的 contentHash → rating
 *   映射恢复；幂等键是 sha256(消息全文)，同一条消息只保留首次评分。
 */
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ThumbsDown, ThumbsUp } from 'lucide-react-native';
import { MESSAGE_FEEDBACK_COMMENT_MAX } from '@agent/shared';
import { sha256Hex, useMessageFeedback } from '../../../contexts/MessageFeedbackContext';
import { BottomSheet, Button, Input } from '../../ui';
import { useColors, useChatTypography, spacing } from '../../../theme';

export function MessageFeedbackButton({
  messageId,
  content,
}: {
  messageId: string;
  content: string;
}) {
  const feedback = useMessageFeedback();
  const colors = useColors();
  const typo = useChatTypography();
  const [visible, setVisible] = useState(false);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 幂等键与服务端一致：sha256(消息全文)；内容不变时不重复计算。
  const contentHash = useMemo(() => sha256Hex(content), [content]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        triggers: { flexDirection: 'row', alignItems: 'center' },
        trigger: { padding: spacing.xs },
        sheetBody: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.md },
        hint: { ...typo.caption, color: colors.mutedForeground },
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

  const submitted = feedback.isSubmitted(contentHash);
  const rating = feedback.submittedRating(contentHash);
  const upLabel = rating === 'up' ? '已反馈：这个回答有帮助' : '反馈这个回答有帮助';
  const downLabel = rating === 'down' ? '已反馈：这个回答有问题' : '反馈这个回答有问题';
  // 未选中的那一侧在已反馈后压成弱色：既禁用又不误导用户以为还能改评分。
  const idleColor = submitted ? colors.border : colors.mutedForeground;

  const handleSubmit = async (nextRating: 'up' | 'down') => {
    if (submitting) return;
    setSubmitting(true);
    const ok = await feedback.submit({
      messageId,
      content,
      rating: nextRating,
      ...(nextRating === 'down' && comment.trim() ? { comment } : {}),
    });
    setSubmitting(false);
    if (ok) {
      setVisible(false);
      setComment('');
    }
  };

  return (
    <>
      <View style={styles.triggers}>
      <Pressable
        testID="message-feedback-up-button"
        accessibilityRole="button"
        accessibilityLabel={upLabel}
        accessibilityState={{ disabled: submitted }}
        hitSlop={8}
        disabled={submitted || submitting}
        onPress={() => { void handleSubmit('up'); }}
        style={styles.trigger}
      >
        <ThumbsUp
          size={14}
          strokeWidth={2}
          color={rating === 'up' ? colors.primary : idleColor}
          fill={rating === 'up' ? colors.primary : 'transparent'}
        />
      </Pressable>
      <Pressable
        testID="message-feedback-button"
        accessibilityRole="button"
        accessibilityLabel={downLabel}
        accessibilityState={{ disabled: submitted }}
        hitSlop={8}
        disabled={submitted}
        onPress={() => setVisible(true)}
        style={styles.trigger}
      >
        <ThumbsDown
          size={14}
          strokeWidth={2}
          color={rating === 'down' ? colors.destructive : idleColor}
          fill={rating === 'down' ? colors.destructive : 'transparent'}
        />
      </Pressable>
      </View>
      <BottomSheet
        visible={visible}
        onClose={() => setVisible(false)}
        title="反馈这个回答的问题"
        testID="message-feedback-sheet"
      >
        <View style={styles.sheetBody}>
          <Text style={styles.hint}>可选：说明问题（如答非所问、信息有误）</Text>
          <Input
            value={comment}
            onChangeText={setComment}
            multiline
            maxLength={MESSAGE_FEEDBACK_COMMENT_MAX}
            autoCapitalize="none"
            placeholder="补充说明（可选）"
            accessibilityLabel="反馈说明"
            testID="message-feedback-input"
          />
          <View style={styles.actions}>
            <Button
              label="取消"
              variant="ghost"
              size="sm"
              onPress={() => {
                setVisible(false);
                setComment('');
              }}
            />
            <Button
              label="提交"
              size="sm"
              loading={submitting}
              onPress={() => {
                void handleSubmit('down');
              }}
              testID="message-feedback-submit"
            />
          </View>
        </View>
      </BottomSheet>
    </>
  );
}
