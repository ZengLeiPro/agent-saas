/**
 * Unified WS Handler — 替代两端独立的 onMessage handler
 *
 * 核心事件处理逻辑从 Web/Mobile useChatAppState 中合并到此处。
 * 使用 store.getState() 始终获取最新状态，彻底消除 stale closure 问题。
 */

import { getChatStore } from '../index';
import { INITIAL_BLOCK_STATE } from '../types';
import { wsClient } from '../../lib/wsClient';
import { getPlatform } from '../../platform/context';
import {
  processWsEvent,
  finalizeRunningSubagents,
  type WsProcessingContext,
} from '../../lib/wsEventProcessor';
import type { WsEvent } from '../../types/ws';
import { loadSessions, refreshCurrentSession, fetchTokenUsage } from './sessionLoader';
import { sendChatViaWs } from './sendChat';

/** 元数据事件白名单（不受 isAttached 守卫过滤） */
const METADATA_EVENTS = new Set([
  'title_updated',
  'session_updated',
  'session_deleted',
  'interaction_resolved',
  'pending_interactions',
  'session_status',
  'groups_changed',
  'sync_ok',
  'sync_overflow',
]);

/** 外部回调注册（平台层设置） */
let _voiceCallback: ((key: string, text: string, voice?: string, speed?: number) => void) | undefined;
let _groupsRefreshCallback: (() => void) | undefined;
let _onNewSession: ((sessionId: string) => void) | undefined;

function toSessionBusyIdle(status: WsEvent extends infer E ? E extends { type: 'session_status'; status: infer S } ? S : never : never): 'busy' | 'idle' {
  return ['busy', 'queued', 'running', 'waiting_approval', 'waiting_user', 'waiting_hand'].includes(String(status)) ? 'busy' : 'idle';
}

export function setVoiceCallback(cb: typeof _voiceCallback): void { _voiceCallback = cb; }
export function setGroupsRefreshCallback(cb: typeof _groupsRefreshCallback): void { _groupsRefreshCallback = cb; }
export function setOnNewSession(cb: typeof _onNewSession): void { _onNewSession = cb; }

/** 安装统一 WS 消息处理器，返回 unsubscribe 函数 */
/** 上次发送 sync 的时间戳（防抖：2s 内不重复发） */
let lastSyncRequestAt = 0;

export function setupWsHandler(): () => void {
  return wsClient.onMessage((envelope: { eventId?: number; eventCursor?: string; seq?: number; data: unknown }) => {
    const data = envelope.data as WsEvent;
    if (!data?.type) return;
    const store = getChatStore();

    // 追踪 eventId（断线重连 resume 用）
    if (envelope.eventId != null) {
      store.setState({ lastEventId: envelope.eventId });
    }
    if (envelope.eventCursor) {
      store.setState({ lastEventCursor: envelope.eventCursor });
    }

    // ── seq gap 检测：发现不连续立即主动 sync，不等心跳 ──
    if (typeof envelope.seq === 'number') {
      const state = store.getState();
      const prevSeq = state.lastUserSeq;
      // 只在已建立基线（prevSeq > 0）且发现 gap 时触发
      if (prevSeq > 0 && envelope.seq > prevSeq + 1) {
        const now = Date.now();
        if (now - lastSyncRequestAt > 2000) {
          lastSyncRequestAt = now;
          wsClient.send({ action: 'sync', lastSeq: prevSeq });
        }
      }
      // 更新 lastUserSeq（只增不减���
      if (envelope.seq > prevSeq) {
        store.setState({ lastUserSeq: envelope.seq });
        wsClient.setLastSeq(envelope.seq);
      }
    }

    // ── 控制消息 ──
    if (data.type === 'respond_ok' || data.type === 'respond_error') return;
    if (data.type === 'abort_ok') {
      const state = store.getState();
      if ((data.runId && data.runId === state.runId) || (data.streamId && data.streamId === state.streamId)) {
        store.setState({ stopping: true });
      }
      return;
    }
    if (data.type === 'active_stream') return; // 由 subscribeToActiveStream 的专用 handler 处理

    // ── sync 协议响应 ──
    if (data.type === 'sync_ok') {
      store.setState({ lastUserSeq: data.seq });
      wsClient.setLastSeq(data.seq);
      // 回放漏掉的元数据事件
      for (const { event } of data.events) {
        const e = event as WsEvent;
        if (e.type === 'title_updated') store.getState().updateSessionTitle(e.sessionId, e.title);
        else if (e.type === 'session_updated') store.getState().updateSessionMeta(e.sessionId, { preview: e.preview, updatedAtMs: e.updatedAtMs });
        else if (e.type === 'session_deleted') store.getState().removeSession(e.sessionId);
        else if (e.type === 'session_status') store.getState().updateSessionStatus(e.sessionId, toSessionBusyIdle(e.status));
        else if (e.type === 'stream_started') void loadSessions({ fresh: true });
        else if (e.type === 'groups_changed') _groupsRefreshCallback?.();
      }
      return;
    }
    if (data.type === 'sync_overflow') {
      store.setState({ lastUserSeq: data.seq });
      wsClient.setLastSeq(data.seq);
      // 降级：全量刷新
      void loadSessions({ fresh: true });
      _groupsRefreshCallback?.();
      return;
    }

    // ── session_status（新增事件）──
    if (data.type === 'session_status') {
      store.getState().updateSessionStatus(data.sessionId, toSessionBusyIdle(data.status));
      if (data.runId && data.sessionId === store.getState().activeSessionId) store.setState({ runId: data.runId });
      return;
    }

    // ── groups_changed（新增事件）──
    if (data.type === 'groups_changed') {
      _groupsRefreshCallback?.();
      return;
    }

    // ── stream_started（其他设备发起的流）──
    if (data.type === 'stream_started') {
      const state = store.getState();
      if (data.sessionId === state.activeSessionId && !state.loading) {
        // 当前正在查看的会话有新流 → 自动订阅
        store.setState({
          streamId: data.streamId,
          runId: data.runId ?? state.runId,
          latestStreamSessionId: data.sessionId,
          isAttached: true,
          loading: true,
          blockState: { ...INITIAL_BLOCK_STATE },
          userMsgIndex: -1,
        });
        store.getState().dispatchConnection('connect');
      }
      void loadSessions({ fresh: true });
      return;
    }

    // ── 防串流守卫：未订阅流时只放行元数据事件 ──
    const state = store.getState();
    if (!state.isAttached && !METADATA_EVENTS.has(data.type)) return;

    // ── 核心事件处理（复用 processWsEvent 纯函数）──
    const ctx: WsProcessingContext = {
      msg: {
        messagesRef: { current: state.getMessagesRef() },
        addMessage: state.addMessage,
        updateMessageAt: state.updateMessageAt,
        triggerScroll: state.triggerScroll,
      },
      session: {
        setIsNewSession: (v) => store.setState({ isNewSession: v }),
        setSessionId: (id) => {
          store.setState({ activeSessionId: id });
          if (id) _onNewSession?.(id);
        },
        loadSessions: () => loadSessions(),
        updateSessionTitle: state.updateSessionTitle,
        updateSessionMeta: (sid, patch) => state.updateSessionMeta(sid, patch),
        removeSession: state.removeSession,
      },
      selectedModelRef: { current: null }, // 由平台层覆盖
      voiceCallbackRef: { current: _voiceCallback },
      streamIdRef: { current: state.streamId },
      runIdRef: { current: state.runId },
      lastEventIdRef: { current: state.lastEventId },
      userMsgIndex: state.userMsgIndex,
      sessionOwnerRef: { current: state.sessionOwner },
      onModelPersist: (sessionId, model) => {
        void getPlatform().storage.setItem(`agentChat.model.${sessionId}`, model);
      },
    };

    const result = processWsEvent(
      data,
      ctx,
      state.blockState,
      { value: state.latestStreamSessionId },
      state.activeSessionId,
    );

    // 同步回 streamId / lastEventId（processWsEvent 可能修改了 ref）
    if (ctx.streamIdRef.current !== state.streamId) {
      store.setState({ streamId: ctx.streamIdRef.current });
    }
    if (ctx.runIdRef?.current !== state.runId) {
      store.setState({ runId: ctx.runIdRef?.current ?? null });
    }

    // ── buffer_overflow ──
    if (result === 'buffer_overflow') {
      store.setState({
        blockState: { ...INITIAL_BLOCK_STATE },
        isAttached: false,
      });
      refreshCurrentSession();
      return;
    }

    // ── done ──
    if (result === 'done') {
      const s = store.getState();
      if (!s.loading) return; // 已 detach

      // 提取 preview
      const msgs = s.getMessagesRef();
      let preview: string | undefined;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].type === 'text' && 'content' in msgs[i]) {
          preview = (msgs[i] as { content: string }).content.slice(0, 200);
          break;
        }
      }

      const latestSid = s.latestStreamSessionId;
      if (latestSid && preview) {
        s.updateSessionMeta(latestSid, { preview, updatedAtMs: Date.now() });
      }

      // 刷新列表和 token
      void loadSessions();
      if (latestSid) void fetchTokenUsage(latestSid);

      // 保存消息缓存
      if (latestSid) {
        getPlatform().messageCache.save(latestSid, s.getMessagesRef());
      }

      // 清理子 Agent
      finalizeRunningSubagents({
        messagesRef: { current: s.getMessagesRef() },
        addMessage: s.addMessage,
        updateMessageAt: s.updateMessageAt,
        triggerScroll: s.triggerScroll,
      });

      // 检查排队消息
      const pending = s.pendingMessage;
      if (!s.stopping && pending) {
        store.setState({ pendingMessage: null });
        void sendChatViaWs({
          inputText: pending.input,
          attachments: pending.attachments as SendChatOptions['attachments'],
          showBubble: false,
        });
      } else {
        store.setState({
          streamId: null,
          runId: null,
          isAttached: false,
          loading: false,
          stopping: false,
        });
        s.dispatchConnection('complete');
      }
      return;
    }
  });
}

// Re-export type for sendChat
import type { SendChatOptions } from './sendChat';
