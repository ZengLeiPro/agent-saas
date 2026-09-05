/**
 * 消息反馈按钮（对齐 `web/src/components/MessageFeedback.tsx`）。
 *
 * - MessageFeedbackContext 缺省（个人 Agent 会话 / 数据面 503）→ 零渲染，
 *   与 Web 同一条兼容性红线。
 * - 点「踩」打开底部弹层填可选原因（≤500 字，上限来自 shared 契约），
 *   提交成功后按钮转实心并禁用，重载后由 Provider 的 contentHash 集合恢复。
 * - 服务端只有「踩」这一种反馈（server/src/routes/feedback.ts 无评分字段），
 *   因此这里不提供点赞入口。
 */
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ThumbsDown } from 'lucide-react-native';
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
  const label = submitted ? '已反馈' : '反馈这个回答有问题';

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    const ok = await feedback.submit({
      messageId,
      content,
      ...(comment.trim() ? { comment } : {}),
    });
    setSubmitting(false);
    if (ok) {
      setVisible(false);
      setComment('');
    }
  };

  return (
    <>
      <Pressable
        testID="message-feedback-button"
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: submitted }}
        hitSlop={8}
        disabled={submitted}
        onPress={() => setVisible(true)}
        style={styles.trigger}
      >
        <ThumbsDown
          size={14}
          strokeWidth={2}
          color={submitted ? colors.destructive : colors.mutedForeground}
          fill={submitted ? colors.destructive : 'transparent'}
        />
      </Pressable>
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
                void handleSubmit();
              }}
              testID="message-feedback-submit"
            />
          </View>
        </View>
      </BottomSheet>
    </>
  );
}
