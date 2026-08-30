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
import type { ChatQueueSnapshot } from '../../lib/chatQueue';
import type { WsEvent, WsSyncRuntimeSnapshot } from '../../types/ws';
import {
  createSyncRecoveryState,
  reduceSyncRecovery,
  type AppliedSyncEvent,
  type SyncInteractionProjection,
  type SyncRuntimeProjection,
} from '../../lib/syncRecovery';
import { loadSessions, refreshCurrentSession, fetchTokenUsage } from './sessionLoader';

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
  'queue_snapshot',
  'queue_item_updated',
  'message_queued',
  'permission_request',
  'ask_user',
  // 插话回退为独立 run 的接管 stream_id 到达时 isAttached 已被目标 run 的 done 清掉，
  // 必须放行；串会话由 processWsEvent 内的 sessionId 校验兜底。
  'stream_id',
]);

/** 外部回调注册（平台层设置） */
let _voiceCallback: ((key: string, text: string, voice?: string, speed?: number) => void) | undefined;
let _groupsRefreshCallback: (() => void) | undefined;
let _onNewSession: ((sessionId: string) => void) | undefined;

export interface SyncRecoveryCallbacks {
  replaceQueue?: (snapshot: ChatQueueSnapshot) => void;
  replaceRuntime?: (sessionId: string, runtime: WsSyncRuntimeSnapshot | SyncRuntimeProjection) => void;
  replacePendingInteractions?: (sessionId: string, interactions: readonly SyncInteractionProjection[]) => void;
  refreshSessionRecovery?: (sessionId?: string) => void;
}
let _syncRecoveryCallbacks: SyncRecoveryCallbacks = {};

function toSessionBusyIdle(status: WsEvent extends infer E ? E extends { type: 'session_status'; status: infer S } ? S : never : never): 'busy' | 'idle' {
  return ['busy', 'queued', 'running', 'waiting_approval', 'waiting_user', 'waiting_hand'].includes(String(status)) ? 'busy' : 'idle';
}

export function setVoiceCallback(cb: typeof _voiceCallback): void { _voiceCallback = cb; }
export function setGroupsRefreshCallback(cb: typeof _groupsRefreshCallback): void { _groupsRefreshCallback = cb; }
export function setOnNewSession(cb: typeof _onNewSession): void { _onNewSession = cb; }
export function setSyncRecoveryCallbacks(callbacks: SyncRecoveryCallbacks): void { _syncRecoveryCallbacks = callbacks; }

/** 安装统一 WS 消息处理器，返回 unsubscribe 函数 */
const handledTerminalKeysRef = { current: new Set<string>() };

export function setupWsHandler(): () => void {
  const baseline = getChatStore().getState();
  let recovery = createSyncRecoveryState({ lastSeq: baseline.lastUserSeq, serverEpoch: baseline.lastUserEpoch });
  let sentSyncRequestId: number | null = null;

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

    // The reducer is the sole sequence/epoch acceptance boundary. wsClient also runs the
    // same kernel at the transport edge; this second boundary protects tests and adapters
    // that feed setupWsHandler directly.
    let appliedEvents: readonly AppliedSyncEvent[] = [];
    const cursorState = store.getState();
    if (recovery.phase === 'idle' && recovery.lastSeq === 0 && cursorState.lastUserSeq > 0) {
      recovery = createSyncRecoveryState({
        lastSeq: cursorState.lastUserSeq,
        serverEpoch: cursorState.lastUserEpoch,
      });
    }
    if (data.type === 'sync_ok') {
      recovery = reduceSyncRecovery(recovery, {
        type: 'sync_ok', seq: data.seq, epoch: data.epoch, events: data.events,
      });
      appliedEvents = recovery.appliedEvents;
    } else if (data.type === 'sync_overflow') {
      recovery = reduceSyncRecovery(recovery, {
        type: 'sync_overflow', seq: data.seq, epoch: data.epoch,
      });
    } else if (data.type === 'pong') {
      recovery = reduceSyncRecovery(recovery, { type: 'pong', seq: data.seq, epoch: data.epoch });
    } else if (typeof envelope.seq === 'number') {
      if (recovery.phase === 'idle' && recovery.lastSeq === 0 && recovery.serverEpoch === null) {
        recovery = { ...recovery, lastSeq: Math.max(0, envelope.seq - 1) };
      }
      recovery = reduceSyncRecovery(recovery, {
        type: 'event', envelope: { seq: envelope.seq, event: data },
      });
      appliedEvents = recovery.appliedEvents;
    }

    const request = recovery.syncRequest;
    if (request && request.id !== sentSyncRequestId) {
      sentSyncRequestId = request.id;
      wsClient.send({
        action: 'sync', lastSeq: request.lastSeq,
        ...(request.epoch ? { epoch: request.epoch } : {}),
        ...(store.getState().activeSessionId ? { sessionId: store.getState().activeSessionId! } : {}),
      });
    }
    if (data.type === 'pong') return;
    if (typeof envelope.seq === 'number' && appliedEvents.length === 0) return;
    store.setState({
      lastUserSeq: recovery.lastSeq,
      ...(recovery.serverEpoch ? { lastUserEpoch: recovery.serverEpoch } : {}),
    });
    wsClient.setLastSeq(recovery.lastSeq);
    if (recovery.serverEpoch) wsClient.setEpoch(recovery.serverEpoch);

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
      // Only reducer-accepted events are projected, once and in contiguous sequence order.
      for (const { event: e } of appliedEvents) {
        if (e.type === 'title_updated') store.getState().updateSessionTitle(e.sessionId, e.title);
        else if (e.type === 'session_updated') store.getState().updateSessionMeta(e.sessionId, { preview: e.preview, updatedAtMs: e.updatedAtMs, title: e.title });
        else if (e.type === 'session_deleted') store.getState().removeSession(e.sessionId);
        else if (e.type === 'session_status') {
          store.getState().updateSessionStatus(e.sessionId, toSessionBusyIdle(e.status));
          if (e.sessionId === store.getState().activeSessionId && e.runId) store.setState({ runId: e.runId });
        } else if (e.type === 'active_stream' || e.type === 'stream_started') {
          const runtime = recovery.runtimeBySession[e.sessionId];
          if (runtime) _syncRecoveryCallbacks.replaceRuntime?.(e.sessionId, runtime);
          if (e.type === 'stream_started') void loadSessions({ fresh: true });
        } else if (e.type === 'queue_snapshot') _syncRecoveryCallbacks.replaceQueue?.(e.snapshot);
        else if (e.type === 'pending_interactions') {
          const sid = store.getState().activeSessionId;
          if (sid) _syncRecoveryCallbacks.replacePendingInteractions?.(sid, e.interactions);
        } else if (e.type === 'permission_request' || e.type === 'ask_user' || e.type === 'interaction_resolved') {
          const sid = 'sessionId' in e && typeof e.sessionId === 'string' ? e.sessionId : store.getState().activeSessionId;
          if (sid) _syncRecoveryCallbacks.replacePendingInteractions?.(sid, Object.values(recovery.interactions));
        } else if (e.type === 'groups_changed') _groupsRefreshCallback?.();
      }
      return;
    }
    if (data.type === 'sync_overflow') {
      const snapshot = data.recovery?.session;
      if (snapshot?.queueSnapshot) _syncRecoveryCallbacks.replaceQueue?.(snapshot.queueSnapshot);
      if (snapshot?.runtime) _syncRecoveryCallbacks.replaceRuntime?.(snapshot.sessionId, snapshot.runtime);
      if (snapshot?.pendingInteractions) {
        _syncRecoveryCallbacks.replacePendingInteractions?.(snapshot.sessionId, snapshot.pendingInteractions);
      }
      // Missing inline sections are never guessed: invoke the existing authoritative refreshes.
      void loadSessions({ fresh: true });
      if (!snapshot?.queueSnapshot || !snapshot.runtime || !snapshot.pendingInteractions) {
        refreshCurrentSession();
        _syncRecoveryCallbacks.refreshSessionRecovery?.(snapshot?.sessionId ?? store.getState().activeSessionId ?? undefined);
      }
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
        setMessages: state.setMessages,
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
      handledTerminalKeysRef,
      lastEventIdRef: { current: state.lastEventId },
      userMsgIndex: state.userMsgIndex,
      sessionOwnerRef: { current: state.sessionOwner },
      onModelPersist: (sessionId, model) => {
        void getPlatform().storage.setItem(`agentChat.model.${sessionId}`, model);
      },
      onActiveUserMsgIndexChange: (index) => {
        // 插话回退为独立 run 的接管：把防串校验的归属索引切到接管消息的气泡
        if (store.getState().userMsgIndex !== index) store.setState({ userMsgIndex: index });
      },
      onStreamAttached: () => {
        // 接管场景：目标 run 的 done 已清掉 attached，这里恢复，后续流式内容才能过守卫
        if (!store.getState().isAttached) store.setState({ isAttached: true });
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

      // M20-02: terminal callbacks only settle UI. pendingMessage remains an editable local
      // intent; durable RunStore queue state is the only business dispatch authority.
      store.setState({
        streamId: null,
        runId: null,
        isAttached: false,
        loading: false,
        stopping: false,
      });
      s.dispatchConnection('complete');
      return;
    }
  });
}
