/**
 * Messages Slice — 消息列表状态 + 流式批量更新
 *
 * 核心设计：内部维护可变数组 _messages（高频流式追加用），
 * 通过 scheduleFlush 合并到 React state。与原 useMessages 逻辑一致。
 */

import type { StateCreator } from 'zustand';
import type { MessageItem, MessageItemInput } from '../../types/message';
import type { ChatStore, MessagesSlice } from '../types';
import { getPlatform } from '../../platform/context';

let _idCounter = 0;
function generateMessageId(): string {
  return `msg-${Date.now()}-${++_idCounter}`;
}

function ensureIds(msgs: MessageItem[]): MessageItem[] {
  return msgs.map(m => (m.id ? m : { ...m, id: generateMessageId() }));
}

export const createMessagesSlice: StateCreator<ChatStore, [], [], MessagesSlice> = (set, get) => {
  let _messages: MessageItem[] = [];
  let _dirty = false;
  let _flushId: number | null = null;

  const scheduleFlush = () => {
    if (_flushId !== null) return;
    const platform = getPlatform();
    _flushId = platform.scheduleFlush(() => {
      _flushId = null;
      _dirty = false;
      set({ messages: [..._messages] });
    });
  };

  const ensureMutable = () => {
    if (!_dirty) {
      _dirty = true;
      _messages = [..._messages];
    }
  };

  const cancelPendingFlush = () => {
    if (_flushId !== null) {
      getPlatform().cancelFlush(_flushId);
      _flushId = null;
    }
  };

  return {
    messages: [],
    shouldScroll: false,
    isNearBottom: true,

    getMessagesRef: () => _messages,

    addMessage(input: MessageItemInput): number {
      const msg = { ...input, id: input.id || generateMessageId() } as MessageItem;
      const shouldScroll = get().shouldScroll || get().isNearBottom;
      ensureMutable();
      _messages.push(msg);
      set({ shouldScroll });
      scheduleFlush();
      return _messages.length - 1;
    },

    updateMessageAt(index: number, updater: (m: MessageItem) => MessageItem): void {
      if (index < 0 || index >= _messages.length) return;
      const shouldScroll = get().shouldScroll || get().isNearBottom;
      ensureMutable();
      _messages[index] = updater(_messages[index]);
      set({ shouldScroll });
      scheduleFlush();
    },

    resetMessages(): void {
      cancelPendingFlush();
      _dirty = false;
      _messages = [];
      set({ messages: [] });
    },

    setMessages(msgs: MessageItemInput[]): void {
      cancelPendingFlush();
      _dirty = false;
      _messages = ensureIds(msgs as MessageItem[]);
      set({ messages: _messages });
    },

    triggerScroll(): void {
      set({ shouldScroll: true });
    },

    flushMessages(): void {
      cancelPendingFlush();
      _dirty = false;
      set({ messages: [..._messages] });
    },

    setShouldScroll(v: boolean): void {
      set({ shouldScroll: v });
    },

    setIsNearBottom(v: boolean): void {
      set({ isNearBottom: v });
    },
  };
};
