import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initPlatform } from '../platform/context';
import type { PlatformDeps } from '../platform/types';
import { AUTH_SESSION_KEY } from './authLifecycle';
import { TOKEN_KEY } from './constants';
import { wsClient } from './wsClient';

const binding = { authEpoch: 1, generation: 1 };
class Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  frames: Array<Record<string, unknown>> = [];
  closes: string[] = [];
  throwOnChat = false;
  constructor(readonly url: string) { Socket.instances.push(this); }
  send(raw: string) {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    if (this.throwOnChat && frame.action === 'chat') throw new Error('native socket closed');
    this.frames.push(frame);
  }
  close(_code?: number, reason = '') { this.readyState = Socket.CLOSED; this.closes.push(reason); }
  open() {
    this.readyState = Socket.OPEN;
    this.onopen?.();
    this.receive({ type: 'auth_ok' });
  }
  receive(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ ...binding, data }) });
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
function platform(getItem?: (key: string) => Promise<string | null>): PlatformDeps {
  return {
    storage: {} as PlatformDeps['storage'],
    secureStorage: {
      getItem: getItem ?? ((key) => Promise.resolve(key === TOKEN_KEY ? 'token' : key === AUTH_SESSION_KEY ? JSON.stringify(binding) : null)),
      setItem: async () => {}, removeItem: async () => {},
    },
    messageCache: {} as PlatformDeps['messageCache'],
    platformConfig: {
      getBaseUrl: () => 'https://api.example.com', getWsUrl: () => 'wss://api.example.com/ws',
      isAuthEnabled: () => true, platform: 'mobile',
    },
    scheduleFlush: () => 0, cancelFlush: () => {},
  };
}
const latest = () => Socket.instances.at(-1)!;
const flush = () => vi.advanceTimersByTimeAsync(0);
const subscriptions: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  wsClient.disconnect();
  wsClient.unfreezeSending();
  wsClient.resumeNonEssentialTransport();
  wsClient.resetRecovery({ sessionId: null });
  wsClient.setOnAuthFailure(null);
  Socket.instances = [];
  initPlatform(platform());
});
afterEach(() => {
  subscriptions.splice(0).forEach((off) => off());
  wsClient.disconnect();
  wsClient.unfreezeSending();
  wsClient.resumeNonEssentialTransport();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('native chat delivery connection races', () => {
  it('shares one connection before asynchronous SecureStore has produced a socket', async () => {
    const token = deferred<string | null>();
    const read = vi.fn((key: string) => key === TOKEN_KEY ? token.promise : Promise.resolve(JSON.stringify(binding)));
    initPlatform(platform(read));
    const connect = wsClient.connect();
    const send = wsClient.ensureConnectedSend({ action: 'chat', message: 'hello', client_msg_id: 'same-flight' });
    await flush();
    expect(Socket.instances).toHaveLength(0);
    expect(read.mock.calls.filter(([key]) => key === TOKEN_KEY)).toHaveLength(1);
    token.resolve('token');
    await flush();
    expect(Socket.instances).toHaveLength(1);
    latest().open();
    await expect(connect).resolves.toBeUndefined();
    await expect(send).resolves.toBe(true);
    expect(latest().frames.filter((frame) => frame.action === 'chat')).toHaveLength(1);
  });

  it.each(['credentials', 'upgrade'] as const)('does not lose send waiters when lifecycle reconnects during %s', async (phase) => {
    const token = deferred<string | null>();
    if (phase === 'credentials') {
      initPlatform(platform((key) => key === TOKEN_KEY ? token.promise : Promise.resolve(JSON.stringify(binding))));
    }
    const send = wsClient.ensureConnectedSend({ action: 'chat', message: 'one intent', client_msg_id: 'stable-id' });
    await flush();
    const old = Socket.instances.at(-1);
    const reconnect = wsClient.forceReconnect();
    token.resolve('token');
    await flush();
    expect(Socket.instances).toHaveLength(phase === 'credentials' ? 1 : 2);
    if (old) {
      expect(old.closes).toContain('Force reconnect');
      old.open(); // a stale auth callback must not settle the current socket
      expect(wsClient.isConnected).toBe(false);
    }
    latest().open();
    await expect(reconnect).resolves.toBeUndefined();
    await expect(send).resolves.toBe(true);
    expect(Socket.instances.flatMap((socket) => socket.frames).filter((frame) => frame.action === 'chat'))
      .toEqual([{ action: 'chat', message: 'one intent', client_msg_id: 'stable-id', ...binding }]);
  });

  it('retains the original connection deadline across repeated reconnects and closes timed-out sockets', async () => {
    const send = wsClient.ensureConnectedSend({ action: 'detach' });
    await flush();
    await vi.advanceTimersByTimeAsync(59_000);
    const reconnectResult = wsClient.forceReconnect().then(() => 'connected', () => 'timeout');
    await flush();
    const timedOut = latest();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(send).resolves.toBe(false);
    await expect(reconnectResult).resolves.toBe('timeout');
    expect(timedOut.closes).toContain('Connection timeout');
    timedOut.open();
    expect(wsClient.isConnected).toBe(false);
    const retry = wsClient.ensureConnectedSend({ action: 'detach' });
    await flush();
    expect(latest()).not.toBe(timedOut);
    latest().open();
    await expect(retry).resolves.toBe(true);
  });

  it('isolates broken state/message subscribers so an ACK still reaches the chat subscriber', async () => {
    subscriptions.push(wsClient.onStateChange(() => { throw new Error('broken screen'); }));
    subscriptions.push(wsClient.onMessage(() => { throw new Error('broken telemetry'); }));
    const ack = vi.fn();
    subscriptions.push(wsClient.onMessage(ack));
    const connect = wsClient.connect();
    await flush();
    expect(() => latest().open()).not.toThrow();
    await connect;
    latest().receive({ type: 'chat_ack', client_msg_id: 'message-1', server_recv_ts: 1 });
    expect(ack).toHaveBeenCalledWith({ data: { type: 'chat_ack', client_msg_id: 'message-1', server_recv_ts: 1 } });
    expect(wsClient.isConnected).toBe(true);
  });

  it('settles a native send exception as false and never automatically resubmits chat on reconnect', async () => {
    const connect = wsClient.connect();
    await flush();
    latest().open();
    await connect;
    latest().throwOnChat = true;
    await expect(wsClient.ensureConnectedSend({ action: 'chat', message: 'do not duplicate', client_msg_id: 'intent-1' }))
      .resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    latest().open();
    await flush();
    expect(Socket.instances.flatMap((socket) => socket.frames).some((frame) => frame.action === 'chat')).toBe(false);
  });

  it('does not send an old account intent or create an old socket after delayed credentials resolve', async () => {
    const oldToken = deferred<string | null>();
    initPlatform(platform((key) => key === TOKEN_KEY ? oldToken.promise : Promise.resolve(JSON.stringify(binding))));
    const oldSend = wsClient.ensureConnectedSend({ action: 'chat', message: 'private old draft', client_msg_id: 'old' });
    await flush();
    wsClient.freezeSending();
    wsClient.disconnect();
    initPlatform(platform());
    wsClient.unfreezeSending();
    const fresh = wsClient.connect();
    await flush();
    latest().open();
    await fresh;
    oldToken.resolve('old-token');
    await flush();
    await expect(oldSend).resolves.toBe(false);
    expect(Socket.instances).toHaveLength(1);
    expect(latest().frames.some((frame) => frame.action === 'chat')).toBe(false);
  });

  it('refuses sends while the native lifecycle is suspended even when readyState is still OPEN', async () => {
    const connect = wsClient.connect();
    await flush();
    latest().open();
    await connect;
    wsClient.suspendNonEssentialTransport();
    await expect(wsClient.ensureConnectedSend({ action: 'chat', message: 'background' })).resolves.toBe(false);
    expect(latest().frames.some((frame) => frame.action === 'chat')).toBe(false);
  });

  it('releases a failed acquire so the next screen can connect and release normally', async () => {
    const failed = wsClient.acquire().then(() => false, () => true);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(failed).resolves.toBe(true);
    const next = wsClient.acquire();
    await flush();
    latest().open();
    const release = await next;
    release();
    expect(wsClient.isConnected).toBe(false);
  });
});
