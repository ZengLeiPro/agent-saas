import http from 'http';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { WsServer } from '../channels/web/wsServer.js';

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      try { resolve(JSON.parse(data.toString())); } catch (err) { reject(err); }
    });
    ws.once('error', reject);
  });
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
}

async function waitUntil(predicate: () => boolean, { timeoutMs = 2_000, intervalMs = 10 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

type AuthoritativeUser = {
  id: string;
  username: string;
  role: 'admin' | 'user';
  tenantId: string;
  disabled?: boolean;
};

async function withWsServer<T>(
  fn: (args: {
    url: string;
    token: string;
    wsServer: WsServer;
    user: AuthoritativeUser;
    tenant: { id: string; disabled?: boolean };
  }) => Promise<T>,
  options: { pingIntervalMs?: number; authTimeoutMs?: number; authEnabled?: boolean; maxPayloadBytes?: number } = {},
): Promise<T> {
  const user: AuthoritativeUser = { id: 'user-1', username: 'alice', role: 'admin', tenantId: 'tenant-1' };
  const tenant = { id: 'tenant-1', disabled: false };
  const userStore = { findById: (id: string) => id === user.id ? { ...user } : undefined };
  const tenantStore = { findById: (id: string) => id === tenant.id ? { ...tenant } : undefined };
  const server = http.createServer((_req, res) => res.end('ok'));
  const wsServer = new WsServer({
    authEnabled: options.authEnabled !== false,
    jwtSecret: options.authEnabled === false ? undefined : 'test-secret',
    pingIntervalMs: options.pingIntervalMs ?? 60_000,
    authTimeoutMs: options.authTimeoutMs ?? 200,
    maxPayloadBytes: options.maxPayloadBytes,
    userStore: userStore as any,
    tenantStore: tenantStore as any,
  });
  wsServer.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  const token = jwt.sign({ sub: user.id, username: user.username, role: user.role, tenantId: user.tenantId }, 'test-secret');
  try {
    return await fn({ url: `ws://127.0.0.1:${address.port}/ws`, token, wsServer, user, tenant });
  } finally {
    wsServer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function openAuthenticated(url: string, token: string, messages?: any[]): Promise<WebSocket> {
  const ws = new WebSocket(url);
  if (messages) ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await waitOpen(ws);
  const authReply = messages ? undefined : waitMessage(ws);
  ws.send(JSON.stringify({ action: 'auth', token }));
  if (messages) await waitUntil(() => messages.some((message) => message.data?.type === 'auth_ok'));
  else await expect(authReply).resolves.toEqual({ data: { type: 'auth_ok' } });
  return ws;
}

describe('WsServer authenticated lifecycle and heartbeat', () => {
  it('accepts an unauthenticated deployment probe without registering a user client', async () => {
    await withWsServer(async ({ url, wsServer }) => {
      const ws = new WebSocket(`${url}?probe=1`);
      const messagePromise = waitMessage(ws);
      await waitOpen(ws);
      await expect(messagePromise).resolves.toEqual({
        data: { type: 'pong', probe: true, epoch: wsServer.userEventLog.epoch },
      });
      expect(wsServer.clientCount).toBe(0);
    });
  });

  it('免认证模式主动确认 auth_ok，客户端无需 token 或 auth 首帧即可收发', async () => {
    await withWsServer(async ({ url, wsServer }) => {
      const ws = new WebSocket(url);
      const authReply = waitMessage(ws);
      await waitOpen(ws);
      await expect(authReply).resolves.toEqual({ data: { type: 'auth_ok' } });
      expect(wsServer.getClients().size).toBe(1);
      const client = [...wsServer.getClients()][0];
      expect(client.authenticated).toBe(true);
      expect(client.user).toBeUndefined();

      const pong = waitMessage(ws);
      ws.send(JSON.stringify({ action: 'ping' }));
      await expect(pong).resolves.toMatchObject({ data: { type: 'pong' } });
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    }, { authEnabled: false });
  });

  it('认证前超大首帧由 maxPayload 拒绝且不进入 JSON.parse', async () => {
    await withWsServer(async ({ url }) => {
      const ws = new WebSocket(url);
      const closed = waitClose(ws);
      await waitOpen(ws);
      const parse = vi.spyOn(JSON, 'parse');
      try {
        ws.send(JSON.stringify({ action: 'auth', token: 'x'.repeat(1024) }));
        await expect(closed).resolves.toMatchObject({ code: 1009 });
        expect(parse).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
      }
    }, { maxPayloadBytes: 128 });
  });

  it('rejects legacy JWT query URLs and allows only a controlled auth first frame', async () => {
    await withWsServer(async ({ url, token }) => {
      const legacy = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
      const legacyError = new Promise<Error>((resolve) => legacy.once('error', resolve));
      await expect(legacyError).resolves.toMatchObject({ message: expect.stringContaining('400') });

      const ws = new WebSocket(url);
      const closed = waitClose(ws);
      await waitOpen(ws);
      ws.send(JSON.stringify({ action: 'ping' }));
      await expect(closed).resolves.toMatchObject({ code: 4401, reason: 'Authentication required' });
    });
  });

  it('closes a transport that does not send the auth first frame before the short deadline', async () => {
    await withWsServer(async ({ url }) => {
      const ws = new WebSocket(url);
      const closed = waitClose(ws);
      await waitOpen(ws);
      await expect(closed).resolves.toMatchObject({ code: 4401, reason: 'Authentication timeout' });
    }, { authTimeoutMs: 30 });
  });

  it('sends lightweight pong before metadata sync replay', async () => {
    await withWsServer(async ({ url, token, wsServer }) => {
      wsServer.userEventLog.push('user-1', { type: 'session_updated', sessionId: 'session-1' });
      const messages: any[] = [];
      const ws = await openAuthenticated(url, token, messages);
      messages.length = 0;
      ws.send(JSON.stringify({ action: 'ping', lastSeq: 0, clientTs: Date.now() }));
      await waitUntil(() => messages.length >= 2);
      const userEpoch = wsServer.userEventLog.getEpoch('user-1');
      expect(messages[0]).toEqual({ data: { type: 'pong', seq: 1, epoch: userEpoch } });
      expect(messages[1].data).toMatchObject({ type: 'sync_ok', seq: 1, epoch: userEpoch });
      ws.close();
    });
  });

  it('legacy client without epoch overflows once per socket and again after epoch rotation', async () => {
    await withWsServer(async ({ url, token, wsServer }) => {
      wsServer.userEventLog.push('user-1', { type: 'session_updated', sessionId: 'session-1' });
      const firstEpoch = wsServer.userEventLog.getEpoch('user-1');
      const messages: any[] = [];
      const ws = await openAuthenticated(url, token, messages);
      messages.length = 0;

      ws.send(JSON.stringify({ action: 'ping', lastSeq: 1 }));
      await waitUntil(() => messages.length >= 2);
      expect(messages.slice(0, 2)).toEqual([
        { data: { type: 'pong', seq: 1, epoch: firstEpoch } },
        { data: { type: 'sync_overflow', seq: 1, epoch: firstEpoch } },
      ]);

      ws.send(JSON.stringify({ action: 'ping', lastSeq: 1 }));
      await waitUntil(() => messages.length >= 3);
      expect(messages[2]).toEqual({ data: { type: 'pong', seq: 1, epoch: firstEpoch } });

      wsServer.userEventLog.stop();
      wsServer.userEventLog.push('user-1', { type: 'session_updated', sessionId: 'session-2' });
      const nextEpoch = wsServer.userEventLog.getEpoch('user-1');
      expect(nextEpoch).not.toBe(firstEpoch);
      ws.send(JSON.stringify({ action: 'ping', lastSeq: 1 }));
      await waitUntil(() => messages.length >= 5);
      expect(messages.slice(3)).toEqual([
        { data: { type: 'pong', seq: 1, epoch: nextEpoch } },
        { data: { type: 'sync_overflow', seq: 1, epoch: nextEpoch } },
      ]);
      ws.close();
    });
  });

  it('forces overflow for a positive lastSeq with a stale epoch', async () => {
    await withWsServer(async ({ url, token, wsServer }) => {
      wsServer.userEventLog.push('user-1', { type: 'session_updated', sessionId: 'session-1' });
      const messages: any[] = [];
      const ws = await openAuthenticated(url, token, messages);
      messages.length = 0;
      ws.send(JSON.stringify({ action: 'ping', lastSeq: 1, epoch: 'previous-instance' }));
      await waitUntil(() => messages.length >= 2);
      const userEpoch = wsServer.userEventLog.getEpoch('user-1');
      expect(messages).toEqual([
        { data: { type: 'pong', seq: 1, epoch: userEpoch } },
        { data: { type: 'sync_overflow', seq: 1, epoch: userEpoch } },
      ]);
      ws.close();
    });
  });

  it('refreshes a downgraded role from the authoritative user store within one heartbeat cycle', async () => {
    await withWsServer(async ({ url, token, wsServer, user }) => {
      const ws = await openAuthenticated(url, token);
      expect([...wsServer.getClientsByUser(user.id)!][0].user?.role).toBe('admin');
      user.role = 'user';
      await waitUntil(() => [...wsServer.getClientsByUser(user.id)!][0].user?.role === 'user', { timeoutMs: 500 });
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    }, { pingIntervalMs: 30 });
  });

  it('invalidates a disabled user within one heartbeat cycle', async () => {
    await withWsServer(async ({ url, token, user }) => {
      const ws = await openAuthenticated(url, token);
      const closed = waitClose(ws);
      user.disabled = true;
      await expect(closed).resolves.toMatchObject({ code: 4003, reason: 'Account disabled' });
    }, { pingIntervalMs: 30 });
  });

  it('invalidates a disabled tenant within one heartbeat cycle', async () => {
    await withWsServer(async ({ url, token, tenant }) => {
      const ws = await openAuthenticated(url, token);
      const closed = waitClose(ws);
      tenant.disabled = true;
      await expect(closed).resolves.toMatchObject({ code: 4003, reason: '组织已被禁用' });
    }, { pingIntervalMs: 30 });
  });

  it('invalidates changed tenant membership within one heartbeat cycle', async () => {
    await withWsServer(async ({ url, token, user }) => {
      const ws = await openAuthenticated(url, token);
      const closed = waitClose(ws);
      user.tenantId = 'tenant-2';
      await expect(closed).resolves.toMatchObject({ code: 4003, reason: 'Tenant membership changed' });
    }, { pingIntervalMs: 30 });
  });
});
