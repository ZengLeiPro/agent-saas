/**
 * 插话队列条的数据与操作。
 *
 * 队列投影是服务端权威的（`chatQueueItems`），撤回也只走既有的 `cancel_queued`
 * WS 动作——服务端只认 `sourceRunId`，撤回结果由 `cancel_queued_result` 回流到
 * 同一个 reducer，这里不维护第二套队列真相。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { selectQueuedMessageEntries, wsClient, type QueuedMessageEntry } from '@agent/shared';
import { useChatAppState } from '../contexts/ChatAppStateContext';

export interface QueuedMessagesController {
  entries: QueuedMessageEntry[];
  /** 正在等待服务端确认撤回的条目。 */
  busyClientMsgId: string | null;
  cancel: (entry: QueuedMessageEntry) => Promise<void>;
  /** 终态条目（已撤销/发送失败）只剩告知价值，允许本地移除。 */
  dismiss: (clientMsgId: string) => void;
}

export function useQueuedMessages(): QueuedMessagesController {
  const { chatQueueItems, sessionId } = useChatAppState();
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const [busyClientMsgId, setBusyClientMsgId] = useState<string | null>(null);

  // 会话切换时本地隐藏集失效——它只对当前会话的条目有意义。
  useEffect(() => {
    setDismissed([]);
    setBusyClientMsgId(null);
  }, [sessionId]);

  const entries = useMemo(
    () =>
      selectQueuedMessageEntries(chatQueueItems, sessionId ?? undefined).filter(
        (entry) => !dismissed.includes(entry.clientMsgId),
      ),
    [chatQueueItems, dismissed, sessionId],
  );

  const cancel = useCallback(async (entry: QueuedMessageEntry) => {
    setBusyClientMsgId(entry.clientMsgId);
    try {
      await wsClient.ensureConnectedSend({
        action: 'cancel_queued',
        sourceRunId: entry.sourceRunId,
      });
    } catch {
      // 传输异常与否定 ACK 的语义相同：条目状态仍以服务端回流为准。
    } finally {
      setBusyClientMsgId((current) => (current === entry.clientMsgId ? null : current));
    }
  }, []);

  const dismiss = useCallback((clientMsgId: string) => {
    setDismissed((current) =>
      current.includes(clientMsgId) ? current : [...current, clientMsgId],
    );
  }, []);

  return { entries, busyClientMsgId, cancel, dismiss };
}
