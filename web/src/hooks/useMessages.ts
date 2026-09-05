import { useRef, useCallback, useEffect } from "react";
import type { RefObject } from "react";
import type { MessageItem, MessageItemInput } from "@/components/types";
import { useMessageBuffer, type MessageFlushScheduler } from "@agent/shared";

/** Web 用 rAF 合帧：同一帧内多次修改只提交一次 state。 */
const animationFrameFlushScheduler: MessageFlushScheduler = (flush) => {
  const rafId = requestAnimationFrame(flush);
  return () => cancelAnimationFrame(rafId);
};

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
  const {
    messages, messagesRef, addMessage, updateMessageAt, resetMessages, setMessages: setBufferMessages,
  } = useMessageBuffer(animationFrameFlushScheduler);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(false);
  /** Written by MessageList's onScroll — true when the list is near the bottom */
  const isNearBottomRef = useRef(true);

  const setMessages = useCallback((msgs: MessageItemInput[], options?: { scrollToBottom?: boolean }) => {
    if (options?.scrollToBottom !== false) {
      // 会话切换、初始加载等场景：强制滚到底部
      shouldScrollRef.current = true;
    }
    // scrollToBottom === false 时不设置 shouldScrollRef，由 effect 根据 isNearBottomRef 决定
    setBufferMessages(msgs);
  }, [setBufferMessages]);

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
