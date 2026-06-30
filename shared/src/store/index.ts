/**
 * Chat Store — 单例 + React hooks
 *
 * getChatStore(): 获取 vanilla store 实例（任何地方可用）
 * useChatStore(selector): React hook（组件中用）
 */

import { useStore } from 'zustand';
import { createChatStore, type ChatStoreApi } from './createStore';

export type { ChatStore } from './types';
export type { ChatStoreApi } from './createStore';
export { INITIAL_BLOCK_STATE } from './types';
export type { ConnectionState, ConnectionAction } from './types';

let _store: ChatStoreApi | null = null;

/** 获取全局 ChatStore 实例（懒初始化单例） */
export function getChatStore(): ChatStoreApi {
  if (!_store) _store = createChatStore();
  return _store;
}

/** React hook: 从 ChatStore 中选择性订阅状态 */
export function useChatStore<T>(selector: (state: ReturnType<ChatStoreApi['getState']>) => T): T {
  return useStore(getChatStore(), selector);
}

/** 重置 store（测试用） */
export function resetChatStore(): void {
  _store = null;
}
