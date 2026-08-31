/**
 * wsClient.ts 测试
 *
 * WebSocket 客户端封装，含副作用。用 vi.stubGlobal('WebSocket', FakeWebSocket)
 * 造一个可控假 socket：手动触发 onopen/onmessage/onclose，检查连接、收发、
 * 重连、心跳、关闭的关键路径。用 vi.useFakeTimers() 控制重连/心跳定时器。
 *
 * 注意：wsClient 是模块级单例（export const wsClient），每个用例之间需彻底 reset
 * （断开 + 复位内部 attempt/state），否则会串扰。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initPlatform } from '../platform/context';
import type { PlatformDeps } from '../platform/types';
import { TOKEN_KEY } from './constants';
import { AUTH_SESSION_KEY } from './authLifecycle';
import { wsClient, type WsState } from './wsClient';

// ── 可控假 WebSocket ──────────────────────────────────────────────────
// 只实现 wsClient 真正用到的表面：readyState / send / close / 四个回调 +
// 静态 CONNECTING/OPEN 常量。构造后停在 CONNECTING，测试手动推进状态。
const FAKE_CONNECTING = 0;
const FAKE_OPEN = 1;
const FAKE_CLOSED = 3;

class FakeWebSocket {
  static CONNECTING = FAKE_CONNECTING;
  static OPEN = FAKE_OPEN;
  static CLOSING = 2;
  static CLOSED = FAKE_CLOSED;

  static instances: FakeWebSocket[] = [];

  url: string;
  readyState: number = FAKE_CONNECTING;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FAKE_CLOSED;
  }

  // ── 测试驱动辅助 ──
  /** 模拟服务端接受连接 */
  simulateOpen(completeAuth = true): void {
    this.readyState = FAKE_OPEN;
    this.onopen?.();
    if (completeAuth) this.simulateMessage({ authEpoch: 1, generation: 1, data: { type: 'auth_ok' } });
  }
  /** 模拟收到一帧（默认注入当前 M30-01 binding） */
  simulateMessage(envelope: unknown): void {
    const framed = envelope && typeof envelope === 'object'
      ? { authEpoch: 1, generation: 1, ...(envelope as object) }
      : envelope;
    this.onmessage?.({ data: JSON.stringify(framed) });
  }
  /** 模拟连接关闭 */
  simulateClose(code = 1006, reason = ''): void {
    this.readyState = FAKE_CLOSED;
    this.onclose?.({ code, reason });
  }
}

// ── 最小 platform：secureStorage 提供 token，platformConfig 提供 URL/策略 ──
function makePlatform(token: string | null = 'tok', authEnabled = true): PlatformDeps {
  const store = new Map<string, string>();
  if (token) {
    store.set(TOKEN_KEY, token);
    store.set(AUTH_SESSION_KEY, JSON.stringify({ authEpoch: 1, generation: 1 }));
  }
  return {
    storage: {} as PlatformDeps['storage'],
    secureStorage: {
      getItem: (k: string) => Promise.resolve(store.get(k) ?? null),
      setItem: (k: string, v: string) => { store.set(k, v); return Promise.resolve(); },
      removeItem: (k: string) => { store.delete(k); return Promise.resolve(); },
    },
    messageCache: {} as PlatformDeps['messageCache'],
    platformConfig: {
      getBaseUrl: () => 'https://api.example.com',
      getWsUrl: () => 'wss://api.example.com/ws',
      isAuthEnabled: () => authEnabled,
      platform: 'web' as const,
    },
    scheduleFlush: () => 0,
    cancelFlush: () => {},
  };
}

/** 取最近一个 FakeWebSocket 实例 */
function latestWs(): FakeWebSocket {
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!ws) throw new Error('尚未创建 WebSocket 实例');
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  initPlatform(makePlatform());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // 单例的 sync 游标会跨用例残留，复位避免串扰
  wsClient.resetRecovery({ sessionId: null });
});

afterEach(() => {
  // 单例复位：intentional close 停掉重连/心跳，并清空监听器
  wsClient.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('wsClient - 建立连接', () => {
  it('connect() 创建 WebSocket，onopen 后进入 connected 且状态回调被触发', async () => {
    const states: WsState[] = [];
    const off = wsClient.onStateChange((s) => states.push(s));

    const p = wsClient.connect();
    // connect 里 await getWsUrl()（异步），需要冲刷微任务队列
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    expect(ws.url).toBe('wss://api.example.com/ws');
    expect(ws.url).not.toContain('tok');
    // 首连状态 connecting
    expect(states).toContain('connecting');

    ws.simulateOpen();
    expect(JSON.parse(ws.sent[0])).toEqual({ action: 'auth', token: 'tok', authEpoch: 1, generation: 1 });
    await p;

    expect(wsClient.isConnected).toBe(true);
    expect(wsClient.currentState).toBe('connected');
    expect(states).toContain('connected');
    off();
  });

  it('认证确认前禁止业务发送，且连接状态保持 connecting', async () => {
    const p = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = latestWs();
    ws.simulateOpen(false);
    expect(wsClient.currentState).toBe('connecting');
    expect(wsClient.send({ action: 'detach' })).toBe(false);
    expect(ws.sent.map((frame) => JSON.parse(frame))).toEqual([{ action: 'auth', token: 'tok', authEpoch: 1, generation: 1 }]);
    ws.simulateMessage({ authEpoch: 1, generation: 1, data: { type: 'auth_ok' } });
    await p;
    expect(wsClient.currentState).toBe('connected');
  });

  it('免认证模式不读取 token、不发送 auth，等待服务端 auth_ok 后连接', async () => {
    const platform = makePlatform(null, false);
    const tokenRead = vi.spyOn(platform.secureStorage, 'getItem');
    initPlatform(platform);

    const p = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = latestWs();
    ws.simulateOpen(false);

    expect(tokenRead).not.toHaveBeenCalled();
    expect(ws.sent).toEqual([]);
    expect(wsClient.currentState).toBe('connecting');
    ws.simulateMessage({ data: { type: 'auth_ok' } });
    await p;
    expect(wsClient.isConnected).toBe(true);
  });

  it('免认证模式即使残留 token 也不会在 auth_ok 前后发送 auth', async () => {
    initPlatform(makePlatform('stale-token', false));
    const p = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = latestWs();
    ws.simulateOpen(false);
    ws.simulateMessage({ data: { type: 'auth_ok' } });
    await p;
    expect(ws.sent).toEqual([]);
  });

  it('connect() 已连接时直接返回，不重复建连', async () => {
    const p = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    latestWs().simulateOpen();
    await p;

    const countBefore = FakeWebSocket.instances.length;
    await wsClient.connect();
    expect(FakeWebSocket.instances.length).toBe(countBefore);
  });
  it('M10-01: untrusted WS is rejected before token read or socket creation', async () => {
    const platform = makePlatform('must-not-leave-storage');
    const tokenRead = vi.spyOn(platform.secureStorage, 'getItem');
    const policyGuard = vi.fn(() => {
      throw new Error('untrusted websocket origin');
    });
    platform.platformConfig.assertTrustedUrl = policyGuard;
    initPlatform(platform);

    const connectPromise = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);

    expect(policyGuard).toHaveBeenCalledWith(
      'wss://api.example.com/ws',
      'websocket',
    );
    expect(tokenRead).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);

    // Settle the intentionally pending reconnect promise without waiting for
    // its normal connect timeout.
    wsClient.disconnect();
    await expect(connectPromise).resolves.toBeUndefined();
  });
});

describe('wsClient - 消息收发、auth binding 与分发', () => {
  async function connectAndOpen() {
    const p = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    latestWs().simulateOpen();
    await p;
  }

  it('onmessage 把普通 envelope 分发给注册的 handler', async () => {
    await connectAndOpen();
    const handler = vi.fn();
    const off = wsClient.onMessage(handler);

    const envelope = { seq: 5, data: { type: 'text', content: 'hi' } };
    latestWs().simulateMessage(envelope);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(envelope);
    off();
  });

  it('rejects an injected event/ACK/replay from an old auth binding', async () => {
    await connectAndOpen();
    const handler = vi.fn();
    wsClient.onMessage(handler);
    latestWs().simulateMessage({ authEpoch: 0, generation: 0, data: { type: 'chat_ack', client_msg_id: 'old' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('pong 帧被内部消费，不转发给 handler', async () => {
    await connectAndOpen();
    const handler = vi.fn();
    wsClient.onMessage(handler);

    latestWs().simulateMessage({ data: { type: 'pong', seq: 10 } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('取消订阅后 handler 不再收到消息', async () => {
    await connectAndOpen();
    const handler = vi.fn();
    const off = wsClient.onMessage(handler);
    off();
    latestWs().simulateMessage({ data: { type: 'text', content: 'x' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('非法 JSON 帧被吞掉，不抛异常也不分发', async () => {
    await connectAndOpen();
    const handler = vi.fn();
    wsClient.onMessage(handler);
    // 直接喂坏数据，不走 simulateMessage 的 JSON.stringify
    expect(() => latestWs().onmessage?.({ data: 'not-json{' })).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('wsClient - 发送', () => {
  async function connectAndOpen() {
    const p = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    latestWs().simulateOpen();
    await p;
  }

  it('send() 已连接时把 JSON 写入 socket 并返回 true', async () => {
    await connectAndOpen();
    const ok = wsClient.send({ action: 'abort', runId: 'r1' });
    expect(ok).toBe(true);
    const ws = latestWs();
    expect(JSON.parse(ws.sent[ws.sent.length - 1])).toEqual({ action: 'abort', runId: 'r1', authEpoch: 1, generation: 1 });
  });

  it('send(sync) 自动带回最近由 sync 确认的服务端 epoch', async () => {
    await connectAndOpen();
    const ws = latestWs();
    ws.simulateMessage({ data: { type: 'sync_ok', seq: 4, epoch: 'server-epoch-2', events: [] } });

    expect(wsClient.send({ action: 'sync', lastSeq: 4 })).toBe(true);
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
      action: 'sync', lastSeq: 4, epoch: 'server-epoch-2', authEpoch: 1, generation: 1,
    });
  });

  it('send() 未连接时返回 false 且不写 socket', () => {
    // 未 connect，无 open 的 ws
    const ok = wsClient.send({ action: 'abort' });
    expect(ok).toBe(false);
  });

  it('M10-01: re-checks policy before sending user content on an open WS', async () => {
    let trusted = true;
    const platform = makePlatform();
    platform.platformConfig.assertTrustedUrl = vi.fn(() => {
      if (!trusted) throw new Error('origin changed');
    });
    initPlatform(platform);

    const connection = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = latestWs();
    ws.simulateOpen();
    await connection;
    const sentBefore = ws.sent.length;

    trusted = false;
    expect(wsClient.send({ action: 'chat', message: 'private user content' })).toBe(false);
    expect(ws.sent).toHaveLength(sentBefore);
    expect(ws.closeCalls.some((call) => call.reason === 'Client disconnect')).toBe(true);
  });

  it('ensureConnectedSend() 未连接时先建连再发送', async () => {
    const p = wsClient.ensureConnectedSend({ action: 'detach' });
    await vi.advanceTimersByTimeAsync(0);
    latestWs().simulateOpen();
    const ok = await p;
    expect(ok).toBe(true);
    const ws = latestWs();
    expect(JSON.parse(ws.sent[ws.sent.length - 1])).toEqual({ action: 'detach', authEpoch: 1, generation: 1 });
  });
});

describe('wsClient - 重连', () => {
  it('非主动关闭时进入 reconnecting，并在退避延迟后重新建连', async () => {
    const p = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    const first = latestWs();
    first.simulateOpen();
    await p;

    const countBefore = FakeWebSocket.instances.length;
    // 意外断线
    first.simulateClose(1006, 'network');
    expect(wsClient.currentState).toBe('reconnecting');

    // 第一档退避 1000ms 后触发 doConnect（内部 await getWsUrl 再冲刷）
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
  });

  it('免认证模式断线重连仍不要求或发送 token', async () => {
    initPlatform(makePlatform(null, false));
    const p = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    const first = latestWs();
    first.simulateOpen(false);
    first.simulateMessage({ data: { type: 'auth_ok' } });
    await p;

    first.simulateClose(1006, 'network');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    const second = latestWs();
    second.simulateOpen(false);
    expect(second.sent).toEqual([]);
    second.simulateMessage({ data: { type: 'auth_ok' } });
    expect(wsClient.isConnected).toBe(true);
  });

  it('epoch restart 后重连 sync 使用新 epoch 与尚未推进的旧 seq', async () => {
    const p = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    const first = latestWs();
    first.simulateOpen();
    await p;

    first.simulateMessage({ data: { type: 'sync_ok', seq: 4, epoch: 'epoch-1', events: [] } });
    // 服务端已换代，但 overflow 尚未抵达；pong 只能作为 liveness，不能提前推进恢复游标。
    first.simulateMessage({ data: { type: 'pong', seq: 9, epoch: 'epoch-2' } });
    first.simulateClose(1006, 'between pong and overflow');

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    const second = latestWs();
    second.simulateOpen();

    expect(wsClient.send({ action: 'sync', lastSeq: 4 })).toBe(true);
    expect(JSON.parse(second.sent.at(-1)!)).toEqual({
      action: 'sync', lastSeq: 4, epoch: 'epoch-2', authEpoch: 1, generation: 1,
    });
  });

  it('主动 disconnect 后 onclose 不触发重连', async () => {
    const p = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = latestWs();
    ws.simulateOpen();
    await p;

    wsClient.disconnect();
    expect(wsClient.currentState).toBe('disconnected');

    const countBefore = FakeWebSocket.instances.length;
    // disconnect 已把 intentionalClose 置真，即便再来 onclose 也不排重连
    ws.simulateClose(1000, 'Client disconnect');
    await vi.advanceTimersByTimeAsync(30000);
    expect(FakeWebSocket.instances.length).toBe(countBefore);
  });

  it('forceReconnect 立即断旧连、重置 attempt 并建新连', async () => {
    const p = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    const first = latestWs();
    first.simulateOpen();
    await p;

    const fp = wsClient.forceReconnect();
    await vi.advanceTimersByTimeAsync(0);
    // 旧 ws 被 close(1000, 'Force reconnect')
    expect(first.closeCalls.some((c) => c.reason === 'Force reconnect')).toBe(true);
    // 建了新连接
    const second = latestWs();
    expect(second).not.toBe(first);
    second.simulateOpen();
    await fp;
    expect(wsClient.isConnected).toBe(true);
  });
});

describe('wsClient - 心跳', () => {
  it('连接后按心跳间隔发送 ping，且 lastSeq 随之带出', async () => {
    const p = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = latestWs();
    ws.simulateOpen();
    await p;

    // 只有可恢复的 sync 结果建立 seq 与服务端实例 epoch 基线。
    ws.simulateMessage({ data: { type: 'sync_ok', seq: 7, epoch: 'server-epoch-1', events: [] } });

    // 推进一个心跳周期（25s）
    await vi.advanceTimersByTimeAsync(25_000);
    const ping = ws.sent.map((s) => JSON.parse(s)).find((m) => m.action === 'ping');
    expect(ping).toBeTruthy();
    expect(ping).toMatchObject({ lastSeq: 7, epoch: 'server-epoch-1' });
  });

  it('心跳超时（长时间无入站帧）会主动 close(4000) 触发重连', async () => {
    const p = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = latestWs();
    ws.simulateOpen();
    await p;

    // 心跳每 25s tick 一次；idle 需 > HEARTBEAT_TIMEOUT_MS(50s) 才关闭。
    // 全程无入站帧：25s tick(idle 25s，发 ping) → 50s tick(idle 50s，不满足) →
    // 75s tick(idle 75s > 50s，触发 close 4000)。推进到 80s 覆盖到第三个 tick。
    await vi.advanceTimersByTimeAsync(80_000);
    expect(ws.closeCalls.some((c) => c.code === 4000)).toBe(true);
  });
});

describe('wsClient - authoritative recovery', () => {
  it('gap 只发送一次带 epoch/sessionId 的 sync，并在连续批次后只投影一次', async () => {
    wsClient.setSyncSessionId('session-1');
    const p = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = latestWs();
    ws.simulateOpen();
    await p;
    const handler = vi.fn();
    wsClient.onMessage(handler);

    ws.simulateMessage({ data: { type: 'sync_ok', seq: 4, epoch: 'epoch-1', events: [] } });
    handler.mockClear();
    ws.simulateMessage({ seq: 6, data: { type: 'title_updated', sessionId: 'session-1', title: 'gap' } });
    ws.simulateMessage({ seq: 6, data: { type: 'title_updated', sessionId: 'session-1', title: 'duplicate gap' } });

    const syncs = ws.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.action === 'sync');
    expect(syncs).toEqual([{ action: 'sync', lastSeq: 4, epoch: 'epoch-1', sessionId: 'session-1', authEpoch: 1, generation: 1 }]);
    expect(handler).not.toHaveBeenCalled();

    ws.simulateMessage({ data: { type: 'sync_ok', seq: 6, epoch: 'epoch-1', events: [
      { seq: 5, event: { type: 'title_updated', sessionId: 'session-1', title: 'five' } },
      { seq: 6, event: { type: 'title_updated', sessionId: 'session-1', title: 'six' } },
    ] } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].data.events).toHaveLength(2);
  });

  it('resetRecovery clears volatile cursor and overflow session context', () => {
    wsClient.resetRecovery({ lastSeq: 9, serverEpoch: 'epoch-x', sessionId: 'session-x' });
    expect(wsClient.getRecoveryCursor()).toEqual({ lastSeq: 9, serverEpoch: 'epoch-x' });
    wsClient.resetRecovery();
    expect(wsClient.getRecoveryCursor()).toEqual({ lastSeq: 0, serverEpoch: null });
  });
});

describe('wsClient - 引用计数 acquire/release', () => {
  it('首次 acquire 触发连接；release 归零后断开', async () => {
    const ap = wsClient.acquire();
    await vi.advanceTimersByTimeAsync(0);
    latestWs().simulateOpen();
    const release = await ap;
    expect(wsClient.isConnected).toBe(true);

    release();
    expect(wsClient.currentState).toBe('disconnected');
    // 幂等：重复 release 不报错
    expect(() => release()).not.toThrow();
  });
});

describe('M20-04 identity boundary fencing', () => {
  it('rejects late frames and reconnects without old cursor, epoch or session id', async () => {
    const firstConnect = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    const old = latestWs();
    old.simulateOpen();
    await firstConnect;
    const handler = vi.fn();
    wsClient.onMessage(handler);
    wsClient.setLastSeq(88);
    wsClient.setEpoch('epoch-a');
    wsClient.setSyncSessionId('session-a');

    wsClient.freezeSending();
    expect(wsClient.send({ action: 'detach' })).toBe(false);
    wsClient.disconnect();
    wsClient.resetRecovery({ sessionId: null });
    wsClient.unfreezeSending();

    old.simulateMessage({ seq: 89, data: { type: 'text', content: 'late-a' } });
    expect(handler).not.toHaveBeenCalled();
    expect(wsClient.getRecoveryCursor()).toEqual({ lastSeq: 0, serverEpoch: null });

    const reconnect = wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    const fresh = latestWs();
    fresh.simulateOpen();
    await reconnect;
    fresh.simulateMessage({ data: { type: 'pong', seq: 2, epoch: 'epoch-b' } });
    const sync = fresh.sent.map(frame => JSON.parse(frame)).find(frame => frame.action === 'sync');
    expect(sync).toMatchObject({ action: 'sync', lastSeq: 0, epoch: 'epoch-b' });
    expect(sync).not.toHaveProperty('sessionId');
  });
});
