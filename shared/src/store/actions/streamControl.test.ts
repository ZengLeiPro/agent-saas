/**
 * streamControl 测试 —— detach / cancel / subscribe
 *
 * mock 外部边界：wsClient（send/ensureConnectedSend/onMessage）、authFetch、
 * wsEventProcessor 的 finalize 函数（纯副作用，验证被调用即可）。
 * store 用真实单例。cancelActiveStream 的 10s 安全超时用 fake timers 驱动。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const wsSend = vi.fn();
const wsEnsureSend = vi.fn(async (..._a: unknown[]) => true);
const wsOnMessage = vi.fn((..._a: unknown[]) => () => {});
vi.mock('../../lib/wsClient', () => ({
  wsClient: {
    send: (...a: unknown[]) => wsSend(...a),
    ensureConnectedSend: (...a: unknown[]) => wsEnsureSend(...a),
    onMessage: (...a: unknown[]) => wsOnMessage(...a),
  },
}));

const finalizeStreaming = vi.fn();
const finalizeSubagents = vi.fn();
vi.mock('../../lib/wsEventProcessor', () => ({
  finalizeStreamingMessages: (...a: unknown[]) => finalizeStreaming(...a),
  finalizeRunningSubagents: (...a: unknown[]) => finalizeSubagents(...a),
}));

const authFetchMock = vi.fn();
vi.mock('../../lib/authFetch', () => ({
  authFetch: (...a: unknown[]) => authFetchMock(...a),
}));

import { detachFromStream, cancelActiveStream, subscribeToActiveStream } from './streamControl';
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
  wsEnsureSend.mockClear();
  wsEnsureSend.mockResolvedValue(true);
  wsOnMessage.mockClear();
  finalizeStreaming.mockClear();
  finalizeSubagents.mockClear();
  authFetchMock.mockReset();
});

describe('detachFromStream', () => {
  it('清空流状态、finalize 消息、发 detach', () => {
    const store = getChatStore();
    store.setState({
      streamId: 's1', runId: 'r1', streamNonce: 3,
      isAttached: true, loading: true, stopping: true,
      userMsgIndex: 4, latestStreamSessionId: 'sess',
      pendingMessage: { input: 'q', attachments: [] },
    });

    detachFromStream();

    const s = store.getState();
    expect(s.streamId).toBeNull();
    expect(s.runId).toBeNull();
    expect(s.isAttached).toBe(false);
    expect(s.loading).toBe(false);
    expect(s.stopping).toBe(false);
    expect(s.pendingMessage).toBeNull();
    expect(s.latestStreamSessionId).toBeNull();
    expect(s.userMsgIndex).toBe(-1);
    expect(s.streamNonce).toBe(4); // 递增
    expect(finalizeStreaming).toHaveBeenCalledTimes(1);
    expect(finalizeSubagents).toHaveBeenCalledTimes(1);
    expect(wsSend).toHaveBeenCalledWith({ action: 'detach' });
  });
});

describe('cancelActiveStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('无 streamId 也无 runId 时直接返回，不发 abort', () => {
    const store = getChatStore();
    store.setState({ streamId: null, runId: null });
    cancelActiveStream();
    expect(wsEnsureSend).not.toHaveBeenCalled();
    expect(store.getState().stopping).toBe(false);
  });

  it('有活跃流：发 abort、置 stopping、清 pendingMessage', () => {
    const store = getChatStore();
    store.setState({ streamId: 's1', runId: 'r1', pendingMessage: { input: 'x', attachments: [] } });
    cancelActiveStream();
    expect(wsEnsureSend).toHaveBeenCalledWith({ action: 'abort', runId: 'r1', streamId: 's1' });
    expect(store.getState().stopping).toBe(true);
    expect(store.getState().pendingMessage).toBeNull();
  });

  it('10s 安全超时：done 未到 → 强制 finalize 并恢复 loading', () => {
    const store = getChatStore();
    store.setState({ streamId: 's1', runId: 'r1', loading: true, streamNonce: 1 });
    cancelActiveStream();
    finalizeStreaming.mockClear();
    finalizeSubagents.mockClear();

    // 推进 10s 触发安全超时（此时 nonce 和 streamId 未变）
    vi.advanceTimersByTime(10_000);

    const s = store.getState();
    expect(s.streamId).toBeNull();
    expect(s.runId).toBeNull();
    expect(s.loading).toBe(false);
    expect(s.stopping).toBe(false);
    expect(s.streamNonce).toBe(2); // 递增
    expect(finalizeStreaming).toHaveBeenCalledTimes(1);
    expect(finalizeSubagents).toHaveBeenCalledTimes(1);
  });

  it('超时触发前 nonce 已变（新流开始）→ 不误伤，保持 loading', () => {
    const store = getChatStore();
    store.setState({ streamId: 's1', runId: 'r1', loading: true, streamNonce: 1 });
    cancelActiveStream();
    // 模拟其间 done 到达：nonce 递增
    store.setState({ streamNonce: 2, loading: true });
    finalizeStreaming.mockClear();

    vi.advanceTimersByTime(10_000);

    // nonce 不匹配，超时回调应 no-op
    expect(finalizeStreaming).not.toHaveBeenCalled();
    expect(store.getState().loading).toBe(true);
  });
});

describe('subscribeToActiveStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('已在 loading 时立即返回，不做 HTTP 检测', async () => {
    const store = getChatStore();
    store.setState({ loading: true, activeSessionId: 'a' });
    const p = subscribeToActiveStream('a');
    await vi.runAllTimersAsync();
    await p;
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it('50ms 等待后活跃会话已切走 → 放弃订阅', async () => {
    const store = getChatStore();
    store.setState({ loading: false, activeSessionId: 'a' });
    const p = subscribeToActiveStream('a');
    // 在 50ms gap 中把会话切走
    store.setState({ activeSessionId: 'b' });
    await vi.runAllTimersAsync();
    await p;
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it('HTTP 检测无活跃流 → 只发 resume(skipReplay) 清理旧订阅，不置 loading', async () => {
    const store = getChatStore();
    store.setState({ loading: false, activeSessionId: 'a' });
    authFetchMock.mockResolvedValue({ ok: true, json: async () => ({ active: false }) });

    const p = subscribeToActiveStream('a');
    await vi.runAllTimersAsync();
    await p;

    expect(authFetchMock).toHaveBeenCalledWith('/api/sessions/a/stream-status');
    expect(wsEnsureSend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'resume', sessionId: 'a', skipReplay: true,
    }));
    expect(store.getState().loading).toBe(false);
  });

  it('HTTP 检测有活跃流 → 乐观置 loading 并发 resume', async () => {
    const store = getChatStore();
    store.setState({ loading: false, activeSessionId: 'a', lastEventId: null });
    authFetchMock.mockResolvedValue({ ok: true, json: async () => ({ active: true }) });

    const p = subscribeToActiveStream('a');
    // 只推进到 resume 发出（50ms + 异步链），不推进到 30s 超时回退
    await vi.advanceTimersByTimeAsync(60);
    // 此刻已注册监听并发 resume、置 loading —— 断言乐观态
    expect(store.getState().loading).toBe(true);
    expect(store.getState().latestStreamSessionId).toBe('a');
    expect(wsOnMessage).toHaveBeenCalled(); // 注册了 active_stream 监听
    expect(wsEnsureSend).toHaveBeenCalledWith(expect.objectContaining({ action: 'resume', sessionId: 'a' }));

    // 清理挂起的 30s 超时定时器
    await vi.runAllTimersAsync();
    await p;
  });

  it('有活跃流但 resume 发送失败 → 退订并回滚 loading', async () => {
    const store = getChatStore();
    store.setState({ loading: false, activeSessionId: 'a', lastEventId: null });
    authFetchMock.mockResolvedValue({ ok: true, json: async () => ({ active: true }) });
    wsEnsureSend.mockResolvedValue(false);
    const unsub = vi.fn();
    wsOnMessage.mockReturnValue(unsub);

    const p = subscribeToActiveStream('a');
    await vi.runAllTimersAsync();
    await p;

    expect(unsub).toHaveBeenCalled();
    expect(store.getState().loading).toBe(false);
  });
});
