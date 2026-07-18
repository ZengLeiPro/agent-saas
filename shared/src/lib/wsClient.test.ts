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
  simulateOpen(): void {
    this.readyState = FAKE_OPEN;
    this.onopen?.();
  }
  /** 模拟收到一帧（envelope JSON） */
  simulateMessage(envelope: unknown): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }
  /** 模拟连接关闭 */
  simulateClose(code = 1006, reason = ''): void {
    this.readyState = FAKE_CLOSED;
    this.onclose?.({ code, reason });
  }
}

// ── 最小 platform：secureStorage 提供 token，platformConfig 提供 URL ──
function makePlatform(token: string | null = 'tok'): PlatformDeps {
  const store = new Map<string, string>();
  if (token) store.set(TOKEN_KEY, token);
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
      getWsUrl: (t: string | null) => `wss://api.example.com/ws?token=${t ?? ''}`,
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
  // 单例的 lastSeq 会跨用例残留，复位避免串扰
  wsClient.setLastSeq(0);
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
    expect(ws.url).toContain('wss://api.example.com/ws?token=tok');
    // 首连状态 connecting
    expect(states).toContain('connecting');

    ws.simulateOpen();
    await p;

    expect(wsClient.isConnected).toBe(true);
    expect(wsClient.currentState).toBe('connected');
    expect(states).toContain('connected');
    off();
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
});

describe('wsClient - 消息收发与分发', () => {
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
    expect(JSON.parse(ws.sent[ws.sent.length - 1])).toEqual({ action: 'abort', runId: 'r1' });
  });

  it('send() 未连接时返回 false 且不写 socket', () => {
    // 未 connect，无 open 的 ws
    const ok = wsClient.send({ action: 'abort' });
    expect(ok).toBe(false);
  });

  it('ensureConnectedSend() 未连接时先建连再发送', async () => {
    const p = wsClient.ensureConnectedSend({ action: 'detach' });
    await vi.advanceTimersByTimeAsync(0);
    latestWs().simulateOpen();
    const ok = await p;
    expect(ok).toBe(true);
    const ws = latestWs();
    expect(JSON.parse(ws.sent[ws.sent.length - 1])).toEqual({ action: 'detach' });
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

    // 收到带 seq 的事件 → 更新内部 lastSeq
    ws.simulateMessage({ seq: 7, data: { type: 'text', content: 'x' } });

    // 推进一个心跳周期（25s）
    await vi.advanceTimersByTimeAsync(25_000);
    const ping = ws.sent.map((s) => JSON.parse(s)).find((m) => m.action === 'ping');
    expect(ping).toBeTruthy();
    expect(ping.lastSeq).toBe(7);
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
