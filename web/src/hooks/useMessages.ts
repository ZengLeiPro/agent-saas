import { useState, useRef, useCallback, useEffect } from "react";
import type { RefObject } from "react";
import type { MessageItem, MessageItemInput } from "@/components/types";

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

export interface MessagesState {
  messages: MessageItem[];
  messagesRef: React.MutableRefObject<MessageItem[]>;
  scrollContainerRef: RefObject<HTMLDivElement>;
  lastMessageRef: RefObject<HTMLDivElement>;
  /** Written by MessageList's onScroll — true when the list is near the bottom */
  isNearBottomRef: React.MutableRefObject<boolean>;
  addMessage: (message: MessageItemInput) => number;
  updateMessageAt: (index: number, updater: (msg: MessageItem) => MessageItem) => void;
  resetMessages: () => void;
  setMessages: (msgs: MessageItemInput[], options?: { scrollToBottom?: boolean }) => void;
  triggerScroll: () => void;
}

export function useMessages(): MessagesState {
  const [messages, setMessagesState] = useState<MessageItem[]>([]);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(false);
  /** Written by MessageList's onScroll — true when the list is near the bottom */
  const isNearBottomRef = useRef(true);
  const messagesRef = useRef<MessageItem[]>([]);
  const rafIdRef = useRef(0);
  /** dirty flag：同一帧内多次修改只做原地更新，flush 时才拷贝数组 */
  const dirtyRef = useRef(false);

  const scheduleFlush = useCallback(() => {
    if (!rafIdRef.current) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = 0;
        dirtyRef.current = false;
        setMessagesState([...messagesRef.current]);
      });
    }
  }, []);

  /**
   * 确保 messagesRef.current 是可安全修改的副本。
   * 同一帧首次修改时拷贝一次，后续修改直接原地更新。
   */
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
    if (index < 0 || index >= messagesRef.current.length) {
      return;
    }

    ensureMutable();
    messagesRef.current[index] = updater(messagesRef.current[index]);
    scheduleFlush();
  }, [scheduleFlush, ensureMutable]);

  const resetMessages = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
    }
    dirtyRef.current = false;
    messagesRef.current = [];
    setMessagesState([]);
  }, []);

  const setMessages = useCallback((msgs: MessageItemInput[], options?: { scrollToBottom?: boolean }) => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
    }
    dirtyRef.current = false;
    const withIds = ensureIds(msgs as MessageItem[]);
    messagesRef.current = withIds;
    if (options?.scrollToBottom !== false) {
      // 会话切换、初始加载等场景：强制滚到底部
      shouldScrollRef.current = true;
    }
    // scrollToBottom === false 时不设置 shouldScrollRef，由 effect 根据 isNearBottomRef 决定
    setMessagesState(withIds);
  }, []);

  const triggerScroll = useCallback(() => {
    shouldScrollRef.current = true;
  }, []);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    const forced = shouldScrollRef.current;
    shouldScrollRef.current = false;

    const scrollToBottom = () => {
      const el = scrollContainerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    };

    if (forced) {
      // Forced scroll (user send, session switch): always scroll
      requestAnimationFrame(scrollToBottom);
      // iOS keyboard dismiss triggers layout reflow (~300ms), scroll again to ensure position
      setTimeout(() => {
        if (isNearBottomRef.current) {
          scrollToBottom();
        }
      }, 350);
      return;
    }

    // Auto-follow: check isNearBottomRef at effect-execution time (not at message-update time)
    // This avoids the race condition where shouldScrollRef was latched to true before the user scrolled away
    if (isNearBottomRef.current) {
      requestAnimationFrame(scrollToBottom);
    }
  }, [messages]);

  // Cleanup rAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  return {
    messages,
    messagesRef,
    scrollContainerRef,
    lastMessageRef,
    isNearBottomRef,
    addMessage,
    updateMessageAt,
    resetMessages,
    setMessages,
    triggerScroll,
  };
}
