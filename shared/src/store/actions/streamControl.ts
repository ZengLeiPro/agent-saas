/**
 * Stream Control — detach / cancel / subscribe 操作
 *
 * 从两端 useChatAppState 中提取的共享逻辑。
 */

import { getChatStore } from '../index';
import { INITIAL_BLOCK_STATE } from '../types';
import { wsClient } from '../../lib/wsClient';
import { finalizeRunningSubagents, finalizeStreamingMessages } from '../../lib/wsEventProcessor';
import { authFetch } from '../../lib/authFetch';
import type { WsEvent } from '../../types/ws';

/** 断开当前流（切换会话时使用，不发 abort） */
export function detachFromStream(): void {
  const store = getChatStore();
  const state = store.getState();

  // 清理子 Agent 标记
  finalizeStreamingMessages({
    messagesRef: { current: state.getMessagesRef() },
    addMessage: state.addMessage,
    updateMessageAt: state.updateMessageAt,
    triggerScroll: state.triggerScroll,
  });
  finalizeRunningSubagents({
    messagesRef: { current: state.getMessagesRef() },
    addMessage: state.addMessage,
    updateMessageAt: state.updateMessageAt,
    triggerScroll: state.triggerScroll,
  });

  store.setState({
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

  wsClient.send({ action: 'detach' });
}

/** 用户点击"停止"按钮 */
export function cancelActiveStream(): void {
  const store = getChatStore();
  const state = store.getState();
  const sid = state.streamId;
  const rid = state.runId;
  if (!sid && !rid) return;

  wsClient.ensureConnectedSend({ action: 'abort', ...(rid ? { runId: rid } : {}), ...(sid ? { streamId: sid } : {}) }).catch(() => {});
  store.setState({ stopping: true, pendingMessage: null });

  // 安全超时：10s 内 done 未到则强制恢复
  const nonceAtAbort = state.streamNonce;
  setTimeout(() => {
    const s = store.getState();
    if (s.streamNonce === nonceAtAbort && s.streamId === sid) {
      finalizeStreamingMessages({
        messagesRef: { current: s.getMessagesRef() },
        addMessage: s.addMessage,
        updateMessageAt: s.updateMessageAt,
        triggerScroll: s.triggerScroll,
      });
      finalizeRunningSubagents({
        messagesRef: { current: s.getMessagesRef() },
        addMessage: s.addMessage,
        updateMessageAt: s.updateMessageAt,
        triggerScroll: s.triggerScroll,
      });

      store.setState({
        streamId: null,
        runId: null,
        streamNonce: s.streamNonce + 1,
        lastEventId: null,
        lastEventCursor: null,
        loading: false,
        stopping: false,
      });
    }
  }, 10_000);
}

/** 进入会话时检测并订阅活跃流 */
export async function subscribeToActiveStream(targetSessionId: string): Promise<void> {
  const store = getChatStore();
  let state = store.getState();
  if (state.loading) return;

  // 等待 detail 加载完成（如果有）
  await new Promise<void>(resolve => setTimeout(resolve, 50));

  state = store.getState();
  if (state.activeSessionId !== targetSessionId || state.loading) return;

  // HTTP 检测活跃流
  let httpActive = true;
  try {
    const statusRes = await authFetch(`/api/sessions/${targetSessionId}/stream-status`);
    if (statusRes.ok) {
      const { active } = await statusRes.json() as { active: boolean };
      httpActive = active;
    }
  } catch { /* fallback */ }

  state = store.getState();
  if (state.activeSessionId !== targetSessionId || state.loading) return;

  if (!httpActive) {
    // 无活跃流，仅清理旧订阅
    void wsClient.ensureConnectedSend({
      action: 'resume',
      sessionId: targetSessionId,
      lastEventId: 0,
      lastEventCursor: null,
      skipReplay: true,
    });
    return;
  }

  // 有活跃流 → 乐观设置 loading
  store.setState({
    loading: true,
    latestStreamSessionId: targetSessionId,
    blockState: { ...INITIAL_BLOCK_STATE },
    userMsgIndex: -1,
  });
  store.getState().dispatchConnection('connect');

  const shouldSkipReplay = state.lastEventId === null;

  // 等待 active_stream 确认
  const handleActiveStream = (envelope: { data: unknown }) => {
    const data = envelope.data as WsEvent;
    if (data.type !== 'active_stream') return;
    if ('sessionId' in data && data.sessionId !== targetSessionId) return;

    unsub();
    clearTimeout(timeoutId);

    const current = store.getState();
    if (current.activeSessionId !== targetSessionId) {
      if (!current.isAttached) store.setState({ loading: false });
      return;
    }

    if (!data.active) {
      store.setState({ loading: false, runId: null, streamId: null });
      return;
    }

    if (data.streamId || data.runId) store.setState({ ...(data.streamId ? { streamId: data.streamId } : {}), ...(data.runId ? { runId: data.runId } : {}) });
    store.setState({ isAttached: true });
  };

  const unsub = wsClient.onMessage(handleActiveStream);

  const ok = await wsClient.ensureConnectedSend({
    action: 'resume',
    sessionId: targetSessionId,
    lastEventId: state.lastEventId ?? 0,
    lastEventCursor: state.lastEventCursor,
    skipReplay: shouldSkipReplay,
  });

  if (!ok) {
    unsub();
    store.setState({ loading: false });
    return;
  }

  // 30s 超时保护
  const timeoutId = setTimeout(() => {
    unsub();
    const s = store.getState();
    if (s.loading && !s.isAttached && s.activeSessionId === targetSessionId) {
      store.setState({ loading: false, runId: null, streamId: null });
    }
  }, 30_000);
}
