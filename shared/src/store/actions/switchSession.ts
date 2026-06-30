/**
 * Atomic Session Switch — 单次 setState 完成所有状态重置
 *
 * 解决原来 selectSession 的非原子问题：
 * detach → reset → set 之间有 async gap，快速切换时可能读到不一致状态。
 */

import { getChatStore } from '../index';
import { INITIAL_BLOCK_STATE } from '../types';
import { wsClient } from '../../lib/wsClient';

/** 原子切换会话：一次 setState 完成 detach + reset + set */
export function switchSession(targetId: string): void {
  const store = getChatStore();
  const state = store.getState();
  if (targetId === state.activeSessionId) return;

  store.setState({
    // Session
    activeSessionId: targetId,
    isNewSession: false,
    tokenUsage: null,
    sessionOwner: undefined,

    // Stream reset
    streamId: null,
    runId: null,
    streamNonce: state.streamNonce + 1,
    lastEventId: null,
    lastEventCursor: null,
    isAttached: false,
    loading: false,
    stopping: false,
    pendingMessage: null,
    blockState: { ...INITIAL_BLOCK_STATE },
    latestStreamSessionId: null,
    userMsgIndex: -1,
  });

  // 清空消息（通过 slice 方法）
  store.getState().resetMessages();

  // 通知服务端取消旧的 EventBuffer 订阅
  wsClient.send({ action: 'detach' });
}

/** 新建会话（清空当前状态） */
export function newSession(): void {
  const store = getChatStore();
  const state = store.getState();

  store.setState({
    activeSessionId: null,
    isNewSession: true,
    tokenUsage: null,
    sessionOwner: undefined,

    streamId: null,
    runId: null,
    streamNonce: state.streamNonce + 1,
    lastEventId: null,
    lastEventCursor: null,
    isAttached: false,
    loading: false,
    stopping: false,
    pendingMessage: null,
    blockState: { ...INITIAL_BLOCK_STATE },
    latestStreamSessionId: null,
    userMsgIndex: -1,
  });

  store.getState().resetMessages();
  wsClient.send({ action: 'detach' });
}
