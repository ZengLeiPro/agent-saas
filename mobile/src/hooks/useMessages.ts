import { useRef, useCallback } from "react";
import type { MessageItem, MessageItemInput } from "@agent/shared";
import { useMessageBuffer } from "@agent/shared";

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
  // mobile 用 setTimeout(0) 合批（shared 默认调度器）。
  // setMessages 不在此处强制 shouldScrollRef=true:
  //  - 首次加载/切换会话: MessageList 的 isInitialLoad 路径独立兜底 scrollToEnd
  //  - 流式追加期间用户在底部: isNearBottomRef 自动跟随
  //  - silent refresh / WS 重连清 streaming / retryMessage: 用户可能正在浏览历史,
  //    不能强制把他拉回底部 (#bug: 切到桌面再切回会被强制滚到最新消息)
  //  - 主动滚动场景请调 triggerScroll()
  const { messages, messagesRef, addMessage, updateMessageAt, resetMessages, setMessages } = useMessageBuffer();
  const shouldScrollRef = useRef(false);
  const isNearBottomRef = useRef(true);

  /** Force scroll to bottom — used when the user actively sends a message */
  const triggerScroll = useCallback(() => {
    shouldScrollRef.current = true;
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
