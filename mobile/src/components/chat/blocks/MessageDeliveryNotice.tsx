import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import type { MessageItem } from '@agent/shared';
import { useColors, useChatTypography } from '../../../theme';
import { useMessageStyles } from './shared';

type UserBubble = Extract<MessageItem, { type: 'user' | 'user-voice' }>;

/** Delivery evidence, not the Agent's execution result. No text matching controls a retry. */
export function messageDeliveryLabel(message: UserBubble): string | null {
  if (message.deliveryPhase === 'verifying') return '正在核验发送状态…';
  if (message.deliveryPhase === 'connecting') return '正在连接，等待发送…';
  if (message.deliveryPhase === 'awaiting_ack') return '已写出，等待受理确认…';
  if (message.status === 'pending') return '发送中…';
  if (message.status === 'queued') return '已受理，正在排队';
  if (message.status !== 'failed') return null;
  if (message.deliveryIssue === 'rejected') return message.failedReason || '服务端未受理，请检查内容或设置。';
  if (!message.clientMsgId) return '缺少原消息标识，无法核验；可重新编辑内容。';
  return message.deliveryIssue === 'missing_payload'
    ? '尚未确认是否送达。可以核验状态，但不能自动重建原始提交。'
    : '尚未确认是否送达，请先核验；不要重复发送新消息。';
}

export function MessageDeliveryNotice({ message, onRetry }: {
  message: UserBubble;
  onRetry?: (message: MessageItem) => void;
}) {
  const styles = useMessageStyles(useColors(), useChatTypography());
  const label = messageDeliveryLabel(message);
  if (!label) return null;
  const actionable = message.status === 'failed' && !message.deliveryPhase && !!onRetry;
  const action = message.deliveryIssue === 'rejected' || !message.clientMsgId ? '重新编辑'
    : message.deliveryIssue === 'missing_payload' ? '核验状态' : '核验并重试';
  return (
    <View>
      <Text
        accessibilityRole={message.status === 'failed' ? 'alert' : 'text'}
        accessibilityLiveRegion="polite"
        style={message.deliveryIssue === 'rejected' ? styles.retryText : styles.pendingText}
      >
        {label}
      </Text>
      {actionable && (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={action}
          accessibilityHint={action === '核验并重试'
            ? '先读取原消息状态，已受理时不会重复发送；未查到时只重试原消息。'
            : action === '核验状态' ? '只读取原消息是否已受理，不重新发送。' : '将内容放回输入框，修改后由你决定是否发送。'}
          onPress={() => onRetry?.(message)}
          style={styles.retryButton}
        >
          <Text style={styles.retryText}>{action}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
