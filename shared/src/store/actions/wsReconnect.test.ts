/**
 * wsReconnect 测试 —— 重连恢复 + loading watchdog
 *
 * mock 外部边界：wsClient、authFetch、wsEventProcessor.finalize*、sessionLoader（loadSessions/refreshCurrentSession）。
 * 覆盖：
 * - handleDisconnecting/handleDisconnected：仅在 loading 时推进 connection 状态机
 * - handleReconnected：发 sync；无活跃流→刷新列表+当前会话；有活跃流→清半截消息+发 resume
 * - watchdog：loading 时才装定时器；超时且无活跃流→强制恢复
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const wsSend = vi.fn();
const wsOnMessage = vi.fn((..._a: unknown[]) => () => {});
vi.mock('../../lib/wsClient', () => ({
  wsClient: {
    send: (...a: unknown[]) => wsSend(...a),
    onMessage: (...a: unknown[]) => wsOnMessage(...a),
  },
}));

const authFetchMock = vi.fn();
vi.mock('../../lib/authFetch', () => ({
  authFetch: (...a: unknown[]) => authFetchMock(...a),
}));

const finalizeStreaming = vi.fn();
const finalizeSubagents = vi.fn();
vi.mock('../../lib/wsEventProcessor', () => ({
  finalizeStreamingMessages: (...a: unknown[]) => finalizeStreaming(...a),
  finalizeRunningSubagents: (...a: unknown[]) => finalizeSubagents(...a),
}));

const loadSessionsMock = vi.fn(async (..._a: unknown[]) => {});
const refreshCurrentMock = vi.fn();
vi.mock('./sessionLoader', () => ({
  loadSessions: (...a: unknown[]) => loadSessionsMock(...a),
  refreshCurrentSession: (...a: unknown[]) => refreshCurrentMock(...a),
}));

import {
  handleReconnected,
  handleDisconnecting,
  handleDisconnected,
  resetWatchdog,
  clearWatchdog,
  onStreamEvent,
} from './wsReconnect';
import { getChatStore, resetChatStore } from '../index';
import { initPlatform } from '../../platform/context';
import type { PlatformDeps } from '../../platform/types';

function makePlatform(): PlatformDeps {
  return {
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    secureStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
    messageCache: { save: () => {}, load: async () => null, clear: async () => {} },
    platformConfig: { getBaseUrl: () => '', getWsUrl: () => '', platform: 'web' },
    scheduleFlush: (cb) => { cb(); return 0; },
    cancelFlush: () => {},
  };
}

beforeEach(() => {
  resetChatStore();
  initPlatform(makePlatform());
  wsSend.mockClear();
  wsOnMessage.mockClear();
  wsOnMessage.mockReturnValue(() => {});
  authFetchMock.mockReset();
  finalizeStreaming.mockClear();
  finalizeSubagents.mockClear();
  loadSessionsMock.mockClear();
  refreshCurrentMock.mockClear();
});

afterEach(() => {
  clearWatchdog();
});

describe('handleDisconnecting / handleDisconnected', () => {
  it('loading 时 disconnecting → connection 进入 reconnecting', () => {
    const store = getChatStore();
    store.setState({ loading: true });
    store.getState().dispatchConnection('connect');
    handleDisconnecting();
    expect(store.getState().connectionState).toBe('reconnecting');
  });

  it('非 loading 时 disconnecting 不改动 connection', () => {
    const store = getChatStore();
    store.setState({ loading: false });
    store.getState().dispatchConnection('connect');
    handleDisconnecting();
    expect(store.getState().connectionState).toBe('connected');
  });

  it('loading 时 disconnected → connection 进入 disconnected', () => {
    const store = getChatStore();
    store.setState({ loading: true });
    handleDisconnected();
    expect(store.getState().connectionState).toBe('disconnected');
  });
});

describe('handleReconnected', () => {
  it('无活跃流：发 sync、刷新列表(fresh)、刷新当前会话', async () => {
    const store = getChatStore();
    store.setState({ loading: false, activeSessionId: 's1', lastUserSeq: 5 });

    await handleReconnected();

    expect(wsSend).toHaveBeenCalledWith({ action: 'sync', lastSeq: 5 });
    expect(store.getState().connectionState).toBe('connected');
    expect(loadSessionsMock).toHaveBeenCalledWith({ fresh: true });
    expect(refreshCurrentMock).toHaveBeenCalled();
  });

  it('有活跃流：清理半截 streaming 消息、发 resume、注册 active_stream 监听', async () => {
    const store = getChatStore();
    store.setState({ loading: true, activeSessionId: 's1', lastEventId: 7, lastEventCursor: 'c' });
    // 预置一条半截 streaming 消息 + 一条正常消息
    store.getState().setMessages([
      { id: 'm1', type: 'text', content: '半截', streaming: true },
      { id: 'm2', type: 'text', content: '完整' },
    ]);

    await handleReconnected();

    // 半截消息被过滤
    expect(store.getState().getMessagesRef().map(m => m.id)).toEqual(['m2']);
    // block 状态重置
    expect(store.getState().userMsgIndex).toBe(-1);
    // 发 resume
    expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'resume', sessionId: 's1', lastEventId: 7, lastEventCursor: 'c',
    }));
    expect(wsOnMessage).toHaveBeenCalled();
    // 不刷新列表（走活跃流分支）
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });
});

describe('watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('非 loading 时 resetWatchdog 不装定时器（无副作用）', async () => {
    const store = getChatStore();
    store.setState({ loading: false });
    resetWatchdog();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finalizeStreaming).not.toHaveBeenCalled();
  });

  it('loading 且无 activeSessionId：60s 超时直接强制恢复 loading', async () => {
    const store = getChatStore();
    store.setState({ loading: true, activeSessionId: null });
    resetWatchdog();

    await vi.advanceTimersByTimeAsync(60_000);

    const s = store.getState();
    expect(s.loading).toBe(false);
    expect(s.isAttached).toBe(false);
    expect(finalizeStreaming).toHaveBeenCalled();
    expect(finalizeSubagents).toHaveBeenCalled();
    expect(refreshCurrentMock).toHaveBeenCalled();
    expect(s.connectionState).toBe('idle'); // complete
  });

  it('loading + 有会话 + HTTP 报告 active=false → 强制恢复', async () => {
    const store = getChatStore();
    store.setState({ loading: true, activeSessionId: 's1' });
    authFetchMock.mockResolvedValue({ ok: true, json: async () => ({ active: false }) });
    resetWatchdog();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(authFetchMock).toHaveBeenCalledWith('/api/sessions/s1/stream-status');
    expect(store.getState().loading).toBe(false);
  });

  it('loading + HTTP 报告 active=true → 不恢复，重新武装 watchdog', async () => {
    const store = getChatStore();
    store.setState({ loading: true, activeSessionId: 's1' });
    authFetchMock.mockResolvedValue({ ok: true, json: async () => ({ active: true }) });
    resetWatchdog();

    await vi.advanceTimersByTimeAsync(60_000);

    // 仍 loading（未被强制恢复）
    expect(store.getState().loading).toBe(true);
    expect(finalizeStreaming).not.toHaveBeenCalled();
  });

  it('onStreamEvent 后超时窗口缩短为 45s', async () => {
    const store = getChatStore();
    store.setState({ loading: true, activeSessionId: null });
    onStreamEvent(); // 置 _lastEventAt，武装 45s watchdog

    // 44s 尚未触发
    await vi.advanceTimersByTimeAsync(44_000);
    expect(store.getState().loading).toBe(true);
    // 再 1s 触发
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getState().loading).toBe(false);
  });

  it('clearWatchdog 取消挂起的定时器', async () => {
    const store = getChatStore();
    store.setState({ loading: true, activeSessionId: null });
    resetWatchdog();
    clearWatchdog();
    await vi.advanceTimersByTimeAsync(60_000);
    // 已取消，不触发恢复
    expect(finalizeStreaming).not.toHaveBeenCalled();
    expect(store.getState().loading).toBe(true);
  });
});
