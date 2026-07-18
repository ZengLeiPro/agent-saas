/**
 * wsHandler 测试 —— 统一 WS 消息分发（重点文件）
 *
 * setupWsHandler() 向 wsClient.onMessage 注册一个 handler，本测试捕获该 handler，
 * 用构造的 envelope 直接调用它，断言 store 状态变化与外部依赖调用。
 *
 * mock 外部边界：
 * - wsClient：捕获 onMessage 回调、spy send/setLastSeq
 * - wsEventProcessor：processWsEvent（返回值可控：done/buffer_overflow/void）、finalizeRunningSubagents
 * - sessionLoader / sendChat：spy 调用
 *
 * store 用真实单例，验证真实状态流转（seq 追踪、乐观订阅、done 收尾、排队重发等）。
 */
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';

// ── wsClient：捕获注册的 handler ──
let captured: ((env: unknown) => void) | null = null;
const wsSend = vi.fn();
const wsSetLastSeq = vi.fn();
vi.mock('../../lib/wsClient', () => ({
  wsClient: {
    onMessage: (cb: (env: unknown) => void) => { captured = cb; return () => { captured = null; }; },
    send: (...a: unknown[]) => wsSend(...a),
    setLastSeq: (...a: unknown[]) => wsSetLastSeq(...a),
  },
}));

// ── wsEventProcessor：可控 processWsEvent 返回值 ──
const processWsEvent = vi.fn();
const finalizeRunningSubagents = vi.fn();
vi.mock('../../lib/wsEventProcessor', () => ({
  processWsEvent: (...a: unknown[]) => processWsEvent(...a),
  finalizeRunningSubagents: (...a: unknown[]) => finalizeRunningSubagents(...a),
}));

// ── sessionLoader / sendChat ──
const loadSessionsMock = vi.fn(async (..._a: unknown[]) => {});
const refreshCurrentMock = vi.fn();
const fetchTokenUsageMock = vi.fn(async (..._a: unknown[]) => {});
vi.mock('./sessionLoader', () => ({
  loadSessions: (...a: unknown[]) => loadSessionsMock(...a),
  refreshCurrentSession: (...a: unknown[]) => refreshCurrentMock(...a),
  fetchTokenUsage: (...a: unknown[]) => fetchTokenUsageMock(...a),
}));

const sendChatMock = vi.fn(async (..._a: unknown[]) => true);
vi.mock('./sendChat', () => ({
  sendChatViaWs: (...a: unknown[]) => sendChatMock(...a),
}));

import { setupWsHandler } from './wsHandler';
import { getChatStore, resetChatStore } from '../index';
import { initPlatform } from '../../platform/context';
import type { PlatformDeps } from '../../platform/types';

let cacheSaveSpy: Mock<(...a: unknown[]) => void>;
let storageSetSpy: Mock<(...a: unknown[]) => void>;

function makePlatform(): PlatformDeps {
  cacheSaveSpy = vi.fn((..._a: unknown[]) => {});
  storageSetSpy = vi.fn((..._a: unknown[]) => {});
  return {
    storage: { getItem: () => null, setItem: (...a) => { storageSetSpy(...a); }, removeItem: () => {} },
    secureStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
    messageCache: { save: (...a) => { cacheSaveSpy(...a); }, load: async () => null, clear: async () => {} },
    platformConfig: { getBaseUrl: () => '', getWsUrl: () => '', platform: 'web' },
    scheduleFlush: (cb) => { cb(); return 0; },
    cancelFlush: () => {},
  };
}

/** 调用捕获的 handler */
function emit(env: Record<string, unknown>) {
  if (!captured) throw new Error('handler 未注册');
  captured(env);
}

beforeEach(() => {
  resetChatStore();
  initPlatform(makePlatform());
  captured = null;
  wsSend.mockClear();
  wsSetLastSeq.mockClear();
  processWsEvent.mockReset();
  processWsEvent.mockReturnValue(undefined);
  finalizeRunningSubagents.mockClear();
  loadSessionsMock.mockClear();
  refreshCurrentMock.mockClear();
  fetchTokenUsageMock.mockClear();
  sendChatMock.mockClear();
  setupWsHandler(); // 注册 handler
});

describe('setupWsHandler — 注册与基本守卫', () => {
  it('注册后 captured handler 可用', () => {
    expect(captured).toBeTypeOf('function');
  });

  it('无 type 的事件被忽略', () => {
    emit({ data: {} });
    expect(processWsEvent).not.toHaveBeenCalled();
  });
});

describe('eventId / eventCursor 追踪', () => {
  it('携带 eventId/eventCursor 时写入 store（用于断线 resume）', () => {
    const store = getChatStore();
    store.setState({ isAttached: true });
    emit({ eventId: 42, eventCursor: 'cur-9', data: { type: 'text' } });
    expect(store.getState().lastEventId).toBe(42);
    expect(store.getState().lastEventCursor).toBe('cur-9');
  });
});

describe('seq gap 检测与主动 sync', () => {
  it('已建基线且发现 gap → 主动发 sync(lastSeq=prev)', () => {
    const store = getChatStore();
    store.setState({ lastUserSeq: 5, isAttached: true });
    // seq 从 5 跳到 8（gap）
    emit({ seq: 8, data: { type: 'text' } });
    expect(wsSend).toHaveBeenCalledWith({ action: 'sync', lastSeq: 5 });
    // lastUserSeq 前进到 8
    expect(store.getState().lastUserSeq).toBe(8);
    expect(wsSetLastSeq).toHaveBeenCalledWith(8);
  });

  it('未建基线（prevSeq=0）时即使跳号也不触发 sync，仅推进基线', () => {
    const store = getChatStore();
    store.setState({ lastUserSeq: 0, isAttached: true });
    emit({ seq: 10, data: { type: 'text' } });
    expect(wsSend).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'sync' }));
    expect(store.getState().lastUserSeq).toBe(10);
  });

  it('seq 连续（+1）不触发 sync', () => {
    const store = getChatStore();
    store.setState({ lastUserSeq: 5, isAttached: true });
    emit({ seq: 6, data: { type: 'text' } });
    expect(wsSend).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'sync' }));
    expect(store.getState().lastUserSeq).toBe(6);
  });
});

describe('控制消息短路', () => {
  it('respond_ok / respond_error 直接返回，不处理', () => {
    emit({ data: { type: 'respond_ok' } });
    emit({ data: { type: 'respond_error' } });
    expect(processWsEvent).not.toHaveBeenCalled();
  });

  it('abort_ok 且 runId 匹配 → 置 stopping', () => {
    const store = getChatStore();
    store.setState({ runId: 'r1' });
    emit({ data: { type: 'abort_ok', runId: 'r1' } });
    expect(store.getState().stopping).toBe(true);
  });

  it('abort_ok 但 id 不匹配 → 不置 stopping', () => {
    const store = getChatStore();
    store.setState({ runId: 'r1', streamId: 's1' });
    emit({ data: { type: 'abort_ok', runId: 'other' } });
    expect(store.getState().stopping).toBe(false);
  });

  it('active_stream 直接返回（由专用 handler 处理）', () => {
    emit({ data: { type: 'active_stream', active: true } });
    expect(processWsEvent).not.toHaveBeenCalled();
  });
});

describe('sync 协议响应', () => {
  it('sync_ok：更新 lastUserSeq、回放元数据事件（title/deleted）', () => {
    const store = getChatStore();
    store.getState().setSessions([
      { sessionId: 's1', updatedAtMs: 1, title: '旧', source: { type: 'web', label: 'WEB' } },
      { sessionId: 's2', updatedAtMs: 2, source: { type: 'web', label: 'WEB' } },
    ]);
    emit({ data: { type: 'sync_ok', seq: 20, events: [
      { event: { type: 'title_updated', sessionId: 's1', title: '新标题' } },
      { event: { type: 'session_deleted', sessionId: 's2' } },
    ] } });

    expect(store.getState().lastUserSeq).toBe(20);
    expect(wsSetLastSeq).toHaveBeenCalledWith(20);
    const s = store.getState().sessions;
    expect(s.find(x => x.sessionId === 's1')!.title).toBe('新标题');
    expect(s.find(x => x.sessionId === 's2')).toBeUndefined();
  });

  it('sync_ok 中 stream_started 事件触发列表刷新', () => {
    emit({ data: { type: 'sync_ok', seq: 3, events: [{ event: { type: 'stream_started' } }] } });
    expect(loadSessionsMock).toHaveBeenCalledWith({ fresh: true });
  });

  it('sync_overflow：更新 seq 并降级全量刷新列表', () => {
    const store = getChatStore();
    emit({ data: { type: 'sync_overflow', seq: 99 } });
    expect(store.getState().lastUserSeq).toBe(99);
    expect(loadSessionsMock).toHaveBeenCalledWith({ fresh: true });
  });
});

describe('session_status / groups_changed', () => {
  it('session_status 带 runId 且是当前会话 → 写入 runId', () => {
    const store = getChatStore();
    store.setState({ activeSessionId: 's1' });
    emit({ data: { type: 'session_status', sessionId: 's1', status: 'running', runId: 'r-new' } });
    expect(store.getState().runId).toBe('r-new');
  });

  it('session_status 非当前会话 → 不写 runId', () => {
    const store = getChatStore();
    store.setState({ activeSessionId: 's1', runId: null });
    emit({ data: { type: 'session_status', sessionId: 'other', status: 'running', runId: 'r-new' } });
    expect(store.getState().runId).toBeNull();
  });
});

describe('stream_started（其他设备发起的流）', () => {
  it('当前会话且未 loading → 自动订阅（置 loading/isAttached/streamId）+ 刷新列表', () => {
    const store = getChatStore();
    store.setState({ activeSessionId: 's1', loading: false });
    emit({ data: { type: 'stream_started', sessionId: 's1', streamId: 'st-1', runId: 'r-1' } });

    const s = store.getState();
    expect(s.loading).toBe(true);
    expect(s.isAttached).toBe(true);
    expect(s.streamId).toBe('st-1');
    expect(s.runId).toBe('r-1');
    expect(s.latestStreamSessionId).toBe('s1');
    expect(s.connectionState).toBe('connected');
    expect(loadSessionsMock).toHaveBeenCalledWith({ fresh: true });
  });

  it('已在 loading 时不自动订阅，仍刷新列表', () => {
    const store = getChatStore();
    store.setState({ activeSessionId: 's1', loading: true, streamId: null });
    emit({ data: { type: 'stream_started', sessionId: 's1', streamId: 'st-1' } });
    expect(store.getState().streamId).toBeNull(); // 未订阅
    expect(loadSessionsMock).toHaveBeenCalledWith({ fresh: true });
  });
});

describe('防串流守卫', () => {
  it('未 isAttached 时非元数据事件被拦截，不进 processWsEvent', () => {
    const store = getChatStore();
    store.setState({ isAttached: false });
    emit({ data: { type: 'text' } });
    expect(processWsEvent).not.toHaveBeenCalled();
  });

  it('未 isAttached 但为元数据事件（title_updated）时放行到 processWsEvent', () => {
    const store = getChatStore();
    store.setState({ isAttached: false });
    emit({ data: { type: 'title_updated', sessionId: 's1', title: 't' } });
    expect(processWsEvent).toHaveBeenCalled();
  });
});

describe('processWsEvent 结果处理', () => {
  it('buffer_overflow → 重置 blockState、置 isAttached=false、刷新当前会话', () => {
    const store = getChatStore();
    store.setState({ isAttached: true });
    processWsEvent.mockReturnValue('buffer_overflow');
    emit({ data: { type: 'text' } });

    expect(store.getState().isAttached).toBe(false);
    expect(refreshCurrentMock).toHaveBeenCalled();
  });

  it('done 且 loading：收尾（清 streamId/loading）、刷新列表/token、dispatch complete', () => {
    const store = getChatStore();
    store.setState({ isAttached: true, loading: true, latestStreamSessionId: 's1', stopping: false, pendingMessage: null });
    store.getState().dispatchConnection('connect');
    processWsEvent.mockReturnValue('done');

    emit({ data: { type: 'done' } });

    const s = store.getState();
    expect(s.loading).toBe(false);
    expect(s.streamId).toBeNull();
    expect(s.isAttached).toBe(false);
    expect(loadSessionsMock).toHaveBeenCalled();
    expect(fetchTokenUsageMock).toHaveBeenCalledWith('s1');
    expect(finalizeRunningSubagents).toHaveBeenCalled();
    expect(s.connectionState).toBe('idle'); // complete
  });

  it('done 但已 detach（非 loading）→ 直接返回，不收尾', () => {
    const store = getChatStore();
    store.setState({ isAttached: true, loading: false });
    processWsEvent.mockReturnValue('done');
    emit({ data: { type: 'done' } });
    expect(loadSessionsMock).not.toHaveBeenCalled();
    expect(finalizeRunningSubagents).not.toHaveBeenCalled();
  });

  it('done 且有排队消息（非 stopping）→ 触发 sendChatViaWs(showBubble=false)', () => {
    const store = getChatStore();
    store.setState({
      isAttached: true, loading: true, stopping: false,
      latestStreamSessionId: 's1',
      pendingMessage: { input: '排队问题', attachments: [] },
    });
    processWsEvent.mockReturnValue('done');

    emit({ data: { type: 'done' } });

    expect(store.getState().pendingMessage).toBeNull();
    expect(sendChatMock).toHaveBeenCalledWith(expect.objectContaining({
      inputText: '排队问题', showBubble: false,
    }));
  });

  it('done + stopping=true 即使有排队消息也不重发', () => {
    const store = getChatStore();
    store.setState({
      isAttached: true, loading: true, stopping: true,
      latestStreamSessionId: 's1',
      pendingMessage: { input: 'x', attachments: [] },
    });
    processWsEvent.mockReturnValue('done');

    emit({ data: { type: 'done' } });

    expect(sendChatMock).not.toHaveBeenCalled();
    expect(store.getState().loading).toBe(false);
  });
});
