/**
 * WS Reconnect — 重连恢复 + sync 协议 + loading watchdog
 */

import { getChatStore } from '../index';
import { INITIAL_BLOCK_STATE } from '../types';
import { wsClient } from '../../lib/wsClient';
import { authFetch } from '../../lib/authFetch';
import { finalizeRunningSubagents, finalizeStreamingMessages } from '../../lib/wsEventProcessor';
import { loadSessions, refreshCurrentSession } from './sessionLoader';
import type { WsEvent } from '../../types/ws';

// ── Loading Watchdog ────────────────────────────────────────

let _watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let _lastEventAt = 0;

export function resetWatchdog(): void {
  if (_watchdogTimer) clearTimeout(_watchdogTimer);
  const store = getChatStore();
  if (!store.getState().loading) return;

  const timeout = _lastEventAt > 0 ? 45_000 : 60_000;
  _watchdogTimer = setTimeout(async () => {
    _watchdogTimer = null;
    const s = store.getState();
    if (!s.loading) return;

    const sid = s.activeSessionId;
    if (!sid) { forceRecoverLoading(); return; }

    // HTTP 健康检查
    try {
      const res = await authFetch(`/api/sessions/${sid}/stream-status`);
      if (res.ok) {
        const { active } = await res.json() as { active: boolean };
        if (active) { resetWatchdog(); return; }
      }
    } catch { /* proceed with recovery */ }

    forceRecoverLoading();
  }, timeout);
}

export function clearWatchdog(): void {
  if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; }
  _lastEventAt = 0;
}

export function onStreamEvent(): void {
  _lastEventAt = Date.now();
  resetWatchdog();
}

function forceRecoverLoading(): void {
  const store = getChatStore();
  const state = store.getState();
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
  store.setState({ loading: false, stopping: false, isAttached: false });
  state.dispatchConnection('complete');
  refreshCurrentSession();
}

// ── Reconnect Handler ───────────────────────────────────────

/**
 * WS 连接恢复后的统一处理流程。
 * 由平台层的 WS lifecycle hook 调用（Web: onStateChange, Mobile: useWsLifecycle）。
 */
export async function handleReconnected(): Promise<void> {
  const store = getChatStore();
  const state = store.getState();

  state.dispatchConnection('connect');

  // 1. 发送 sync 请求恢复漏掉的元数据事件
  wsClient.send({ action: 'sync', lastSeq: state.lastUserSeq });

  // 2. 如果有活跃流，尝试恢复
  if (state.loading && state.activeSessionId) {
    const targetSid = state.activeSessionId;

    // 清理半截的流式消息
    const msgs = state.getMessagesRef();
    const cleanedMsgs = msgs.filter(m => !('streaming' in m && m.streaming));
    if (cleanedMsgs.length !== msgs.length) {
      state.setMessages(cleanedMsgs);
    }

    // 重置 block 状态
    store.setState({
      blockState: { ...INITIAL_BLOCK_STATE },
      userMsgIndex: -1,
    });

    // 等待 active_stream 确认
    const handleActiveStream = (envelope: { data: unknown }) => {
      const d = envelope.data as WsEvent;
      if (d.type !== 'active_stream') return;
      if ('sessionId' in d && d.sessionId !== targetSid) return;

      unsub();
      clearTimeout(timeoutId);

      const current = store.getState();
      if (current.activeSessionId !== targetSid) return;

      if (!d.active) {
        store.setState({ isAttached: false, loading: false, streamId: null, runId: null });
        refreshCurrentSession();
      } else if (d.streamId || d.runId) {
        store.setState({ ...(d.streamId ? { streamId: d.streamId } : {}), ...(d.runId ? { runId: d.runId } : {}), isAttached: true });
      }
    };

    const unsub = wsClient.onMessage(handleActiveStream);
    wsClient.send({
      action: 'resume',
      sessionId: targetSid,
      lastEventId: state.lastEventId ?? 0,
      lastEventCursor: state.lastEventCursor,
    });

    const timeoutId = setTimeout(() => {
      unsub();
      const s = store.getState();
      if (s.loading && !s.isAttached && s.activeSessionId === targetSid) {
        store.setState({ loading: false });
        refreshCurrentSession();
      }
    }, 30_000);
  } else {
    // 无活跃流：刷新列表和当前会话
    void loadSessions({ fresh: true });
    refreshCurrentSession();
  }
}

/** WS 断线时的处理 */
export function handleDisconnecting(): void {
  const store = getChatStore();
  if (store.getState().loading) {
    store.getState().dispatchConnection('drop');
  }
}

/** WS 完全断开时的处理 */
export function handleDisconnected(): void {
  const store = getChatStore();
  if (store.getState().loading) {
    store.getState().dispatchConnection('reconnect_fail');
  }
}
