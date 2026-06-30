import { useState, useRef, useCallback, useEffect } from "react";
import type { MessageItem, MessageItemInput } from "@agent/shared";

let messageIdCounter = 0;
const generateMessageId = () => `msg-${Date.now()}-${++messageIdCounter}`;

function ensureIds(msgs: MessageItem[]): MessageItem[] {
  let mutated = false;
  const result = msgs.map((m) => {
    if (m.id) return m;
    mutated = true;
    return { ...m, id: generateMessageId() } as MessageItem;
  });
  return mutated ? result : msgs;
}

export interface MessagesState {
  messages: MessageItem[];
  messagesRef: React.MutableRefObject<MessageItem[]>;
  shouldScrollRef: React.MutableRefObject<boolean>;
  /** Written by MessageList's onScroll — true when the list is near the bottom */
  isNearBottomRef: React.MutableRefObject<boolean>;
  addMessage: (message: MessageItemInput) => number;
  updateMessageAt: (index: number, updater: (msg: MessageItem) => MessageItem) => void;
  resetMessages: () => void;
  setMessages: (msgs: MessageItemInput[]) => void;
  triggerScroll: () => void;
}

export function useMessages(): MessagesState {
  const [messages, setMessagesState] = useState<MessageItem[]>([]);
  const shouldScrollRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const messagesRef = useRef<MessageItem[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);

  const scheduleFlush = useCallback(() => {
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        dirtyRef.current = false;
        setMessagesState([...messagesRef.current]);
      }, 0);
    }
  }, []);

  const ensureMutable = useCallback(() => {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      messagesRef.current = [...messagesRef.current];
    }
  }, []);

  const addMessage = useCallback((message: MessageItemInput): number => {
    ensureMutable();
    const messageWithId = { ...message, id: message.id || generateMessageId() } as MessageItem;
    messagesRef.current.push(messageWithId);
    scheduleFlush();
    return messagesRef.current.length - 1;
  }, [scheduleFlush, ensureMutable]);

  const updateMessageAt = useCallback((index: number, updater: (message: MessageItem) => MessageItem) => {
    if (index < 0 || index >= messagesRef.current.length) return;
    ensureMutable();
    messagesRef.current[index] = updater(messagesRef.current[index]);
    scheduleFlush();
  }, [scheduleFlush, ensureMutable]);

  const resetMessages = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    dirtyRef.current = false;
    messagesRef.current = [];
    setMessagesState([]);
  }, []);

  const setMessages = useCallback((msgs: MessageItemInput[]) => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    dirtyRef.current = false;
    const withIds = ensureIds(msgs as MessageItem[]);
    messagesRef.current = withIds;
    // 不在此处强制 shouldScrollRef=true:
    //  - 首次加载/切换会话: MessageList 的 isInitialLoad 路径独立兜底 scrollToEnd
    //  - 流式追加期间用户在底部: isNearBottomRef 自动跟随
    //  - silent refresh / WS 重连清 streaming / retryMessage: 用户可能正在浏览历史,
    //    不能强制把他拉回底部 (#bug: 切到桌面再切回会被强制滚到最新消息)
    //  - 主动滚动场景请调 triggerScroll()
    setMessagesState(withIds);
  }, []);

  /** Force scroll to bottom — used when the user actively sends a message */
  const triggerScroll = useCallback(() => {
    shouldScrollRef.current = true;
  }, []);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
    };
  }, []);

  return {
    messages,
    messagesRef,
    shouldScrollRef,
    isNearBottomRef,
    addMessage,
    updateMessageAt,
    resetMessages,
    setMessages,
    triggerScroll,
  };
}
