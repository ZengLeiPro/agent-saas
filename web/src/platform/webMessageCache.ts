import type { IMessageCache, MessageItem } from '@agent/shared';
import {
  saveSessionMessages,
  loadSessionMessages,
  clearSessionMessages,
} from '@/lib/messageCache';

/** Web message cache — delegates to existing IndexedDB implementation */
export const webMessageCache: IMessageCache = {
  save(sessionId: string, messages: MessageItem[]): void {
    saveSessionMessages(sessionId, messages);
  },
  async load(sessionId: string): Promise<MessageItem[] | null> {
    return loadSessionMessages(sessionId);
  },
  async clear(sessionId: string): Promise<void> {
    return clearSessionMessages(sessionId);
  },
};
