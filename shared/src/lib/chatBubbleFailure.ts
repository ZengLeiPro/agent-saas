import type { MutableRefObject } from 'react';
import type { MessageItem } from '../types/message';

/** `useMessageBuffer` 的最小子集：读当前消息数组、按下标更新。 */
export interface MessageBubbleTarget {
  messagesRef: MutableRefObject<MessageItem[]>;
  updateMessageAt: (index: number, updater: (message: MessageItem) => MessageItem) => void;
}

/**
 * 把一条用户气泡翻成 failed（两端 `useChatAppState.markBubbleFailed` 共同实现）：
 * 优先按 `clientMsgId` 从尾部找 user / user-voice 气泡，找不到再回退到调用方给的下标。
 */
export function markMessageBubbleFailed(
  target: MessageBubbleTarget,
  clientMsgId: string | undefined,
  fallbackIndex: number,
  reason: string,
): void {
  const msgs = target.messagesRef.current;
  let idx = -1;
  if (clientMsgId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (
        (m.type === 'user' || m.type === 'user-voice') &&
        'clientMsgId' in m &&
        m.clientMsgId === clientMsgId
      ) {
        idx = i;
        break;
      }
    }
  }
  if (idx < 0) idx = fallbackIndex;
  if (idx < 0) return;
  target.updateMessageAt(idx, (m) => {
    if (m.type === 'user') return { ...m, status: 'failed' as const, failedReason: reason };
    if (m.type === 'user-voice') return { ...m, status: 'failed' as const, failedReason: reason };
    return m;
  });
}
