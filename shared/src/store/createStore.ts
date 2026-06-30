/**
 * Store Factory — 使用 zustand/vanilla 创建框架无关的 store。
 * Web 和 Mobile 通过 React hook 包装消费。
 */

import { createStore } from 'zustand/vanilla';
import type { ChatStore } from './types';
import { createMessagesSlice } from './slices/messagesSlice';
import { createSessionSlice } from './slices/sessionSlice';
import { createStreamSlice } from './slices/streamSlice';
import { createConnectionSlice } from './slices/connectionSlice';

export function createChatStore() {
  return createStore<ChatStore>()((...a) => ({
    ...createMessagesSlice(...a),
    ...createSessionSlice(...a),
    ...createStreamSlice(...a),
    ...createConnectionSlice(...a),
  }));
}

export type ChatStoreApi = ReturnType<typeof createChatStore>;
