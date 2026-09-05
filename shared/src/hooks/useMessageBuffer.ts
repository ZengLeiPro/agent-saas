import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { MessageItem, MessageItemInput } from '../types/message';

/**
 * 消息缓冲区（Web `useMessages` 与 mobile `useMessages` 的共同内核）。
 *
 * 内核只管平台无关的部分：
 * - `messages` 状态与同步镜像 `messagesRef`；
 * - 同一批次内多次修改只做原地更新（dirty 标记），flush 时才拷贝数组并提交 state；
 * - `add / updateAt / reset / set` 四个原语，以及缺 `id` 的消息补 id。
 *
 * 平台侧只剩：flush 用什么调度（Web `requestAnimationFrame`，mobile `setTimeout 0`）
 * 以及滚动策略（Web 自动跟随 effect，mobile 由 MessageList 读 `shouldScrollRef`）。
 */

/** 安排一次 flush；返回取消函数。 */
export type MessageFlushScheduler = (flush: () => void) => () => void;

/** 宏任务调度：mobile 默认；也是没有 rAF 的环境的兜底。 */
export const timeoutMessageFlushScheduler: MessageFlushScheduler = (flush) => {
  const timer = setTimeout(flush, 0);
  return () => clearTimeout(timer);
};

export interface MessageBuffer {
  messages: MessageItem[];
  messagesRef: MutableRefObject<MessageItem[]>;
  addMessage: (message: MessageItemInput) => number;
  updateMessageAt: (index: number, updater: (msg: MessageItem) => MessageItem) => void;
  resetMessages: () => void;
  setMessages: (msgs: MessageItemInput[]) => void;
}

let messageIdCounter = 0;
const generateMessageId = () => `msg-${Date.now()}-${++messageIdCounter}`;

/** Ensure every message in the array has an `id` field */
function ensureIds(msgs: MessageItem[]): MessageItem[] {
  let mutated = false;
  const result = msgs.map((m) => {
    if (m.id) return m;
    mutated = true;
    return { ...m, id: generateMessageId() } as MessageItem;
  });
  return mutated ? result : msgs;
}

export function useMessageBuffer(
  scheduler: MessageFlushScheduler = timeoutMessageFlushScheduler,
): MessageBuffer {
  const [messages, setMessagesState] = useState<MessageItem[]>([]);
  const messagesRef = useRef<MessageItem[]>([]);
  const cancelFlushRef = useRef<(() => void) | null>(null);
  /** dirty flag：同一批次内多次修改只做原地更新，flush 时才拷贝数组 */
  const dirtyRef = useRef(false);
  const schedulerRef = useRef(scheduler);
  schedulerRef.current = scheduler;

  const cancelPendingFlush = useCallback(() => {
    if (cancelFlushRef.current) {
      cancelFlushRef.current();
      cancelFlushRef.current = null;
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (!cancelFlushRef.current) {
      cancelFlushRef.current = schedulerRef.current(() => {
        cancelFlushRef.current = null;
        dirtyRef.current = false;
        setMessagesState([...messagesRef.current]);
      });
    }
  }, []);

  /**
   * 确保 messagesRef.current 是可安全修改的副本。
   * 同一批次首次修改时拷贝一次，后续修改直接原地更新。
   */
  const ensureMutable = useCallback(() => {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      messagesRef.current = [...messagesRef.current];
    }
  }, []);

  const addMessage = useCallback(
    (message: MessageItemInput): number => {
      ensureMutable();
      const messageWithId = { ...message, id: message.id || generateMessageId() } as MessageItem;
      messagesRef.current.push(messageWithId);
      scheduleFlush();
      return messagesRef.current.length - 1;
    },
    [scheduleFlush, ensureMutable],
  );

  const updateMessageAt = useCallback(
    (index: number, updater: (message: MessageItem) => MessageItem) => {
      if (index < 0 || index >= messagesRef.current.length) return;
      ensureMutable();
      messagesRef.current[index] = updater(messagesRef.current[index]);
      scheduleFlush();
    },
    [scheduleFlush, ensureMutable],
  );

  const resetMessages = useCallback(() => {
    cancelPendingFlush();
    dirtyRef.current = false;
    messagesRef.current = [];
    setMessagesState([]);
  }, [cancelPendingFlush]);

  const setMessages = useCallback(
    (msgs: MessageItemInput[]) => {
      cancelPendingFlush();
      dirtyRef.current = false;
      const withIds = ensureIds(msgs as MessageItem[]);
      messagesRef.current = withIds;
      setMessagesState(withIds);
    },
    [cancelPendingFlush],
  );

  // 卸载时取消未执行的 flush
  useEffect(() => cancelPendingFlush, [cancelPendingFlush]);

  return {
    messages,
    messagesRef,
    addMessage,
    updateMessageAt,
    resetMessages,
    setMessages,
  };
}
