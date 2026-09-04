import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import jwt from 'jsonwebtoken';
import express from 'express';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthEpochAuthority } from '../auth/authEpochAuthority.js';
import { createAuthMiddleware } from '../auth/middleware.js';
import { WsServer } from '../channels/web/wsServer.js';

const SECRET = 'm30-01-test-secret-that-is-at-least-thirty-two-bytes';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function waitOpen(ws: WebSocket) { return new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); }
function waitMessage(ws: WebSocket) { return new Promise<any>((resolve, reject) => { ws.once('message', (raw) => resolve(JSON.parse(raw.toString()))); ws.once('error', reject); }); }
function waitClose(ws: WebSocket) { return new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))); }

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'auth-epoch-'));
  roots.push(root);
  const audit = vi.fn();
  const authority = new AuthEpochAuthority(join(root, 'epochs.json'), audit);
  const user = { id: 'u1', username: 'alice', role: 'user' as const, tenantId: 't1' };
  const wsServer = new WsServer({
    authEnabled: true,
    jwtSecret: SECRET,
    authEpochAuthority: authority,
    userStore: { findById: (id: string) => id === user.id ? user : undefined } as never,
  });
  const server = http.createServer();
  wsServer.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen failed');
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const close = async () => {
    wsServer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { authority, audit, wsServer, url, user, close, root };
}

function token(user: { id: string; username: string; role: string; tenantId: string }, binding: { authEpoch: number; generation: number }) {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role, tenantId: user.tenantId, ...binding }, SECRET, { expiresIn: '1h' });
}

async function authenticate(url: string, signed: string, binding: { authEpoch: number; generation: number }) {
  const ws = new WebSocket(url);
  const reply = waitMessage(ws);
  await waitOpen(ws);
  ws.send(JSON.stringify({ action: 'auth', token: signed, ...binding }));
  await expect(reply).resolves.toMatchObject({ ...binding, data: { type: 'auth_ok' } });
  return ws;
}

describe('M30-01 server auth epoch authority', () => {
  it('keeps concurrent logins valid, revokes one generation on logout, and fences all on revoke', async () => {
    const h = await createHarness();
    const first = h.authority.upgradeLegacy(h.user.id);
    expect(first).toEqual({ authEpoch: 1, generation: 1 });
    expect(h.authority.upgradeLegacy(h.user.id)).toBeNull();
    const web = h.authority.issueLogin(h.user.id);
    const phone = h.authority.issueLogin(h.user.id);
    expect(web).toEqual({ authEpoch: 1, generation: 2 });
    expect(phone).toEqual({ authEpoch: 1, generation: 3 });
    // 新登录不再驱逐同一用户的其他会话
    expect(h.authority.validates(h.user.id, first)).toBe(true);
    expect(h.authority.validates(h.user.id, web)).toBe(true);
    expect(h.authority.validates(h.user.id, phone)).toBe(true);

    // logout 只撤销自己的 generation，且重复调用幂等
    expect(h.authority.revokeGeneration(h.user.id, web)).toEqual({ ...web, duplicate: false });
    expect(h.authority.revokeGeneration(h.user.id, web)).toEqual({ ...web, duplicate: true });
    expect(h.authority.validates(h.user.id, web)).toBe(false);
    expect(h.authority.validates(h.user.id, phone)).toBe(true);
    expect(h.authority.revokeGeneration(h.user.id, { authEpoch: 1 })).toBeNull();
    expect(h.authority.revokeGeneration(h.user.id, { authEpoch: 9, generation: 3 })).toBeNull();

    // 用户级围栏推进 authEpoch，此前所有登录全部失效
    const fence = h.authority.fence(h.user.id, 'revoke');
    expect(fence).toEqual({ authEpoch: 2, generation: 4 });
    expect(h.authority.validates(h.user.id, phone)).toBe(false);
    expect(h.authority.revokeGeneration(h.user.id, phone)).toEqual({ authEpoch: 2, generation: 3, duplicate: true });

    const restarted = new AuthEpochAuthority(join(h.root, 'epochs.json'));
    expect(restarted.current(h.user.id)).toEqual({ ...fence, fenced: true });
    expect(restarted.validates(h.user.id, restarted.issueLogin(h.user.id))).toBe(true);
    expect(h.audit.mock.calls.map(([event]) => [event.event, event.generation])).toEqual([
      ['legacy_token_upgraded', 1], ['auth_epoch_issued', 2], ['auth_epoch_issued', 3],
      ['auth_generation_revoked', 2], ['auth_epoch_fenced', 4],
    ]);
    await h.close();
  });

  it('migrates single-generation records written before concurrent sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auth-epoch-legacy-'));
    roots.push(root);
    const filePath = join(root, 'epochs.json');
    await writeFile(filePath, JSON.stringify({ version: 1, users: {
      live: { authEpoch: 5, generation: 5, updatedAt: 'x', reason: 'login', fenced: false },
      gone: { authEpoch: 3, generation: 3, updatedAt: 'x', reason: 'logout', fenced: true },
    } }));
    const authority = new AuthEpochAuthority(filePath);
    expect(authority.validates('live', { authEpoch: 5, generation: 5 })).toBe(true);
    expect(authority.validates('live', { authEpoch: 5, generation: 4 })).toBe(false);
    expect(authority.validates('gone', { authEpoch: 3, generation: 3 })).toBe(false);
    expect(authority.issueLogin('live')).toEqual({ authEpoch: 5, generation: 6 });
    expect(authority.validates('live', { authEpoch: 5, generation: 5 })).toBe(true);
    expect(authority.issueLogin('gone')).toEqual({ authEpoch: 3, generation: 4 });
    expect(authority.validates('gone', { authEpoch: 3, generation: 3 })).toBe(false);
  });

  it('upgrades one N-1 token, returns its binding, then rejects replay of the epoch-less token', async () => {
    const h = await createHarness();
    const app = express();
    app.use('/api', createAuthMiddleware(
      SECRET,
      { findById: (id: string) => id === h.user.id ? h.user : undefined } as never,
      undefined,
      '1h',
      undefined,
      h.authority,
    ));
    app.get('/api/protected', (req, res) => res.json({ authEpoch: req.user?.authEpoch, generation: req.user?.generation }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listen failed');
    const base = `http://127.0.0.1:${address.port}`;
    const legacy = jwt.sign({ sub: h.user.id, username: h.user.username, role: h.user.role, tenantId: h.user.tenantId }, SECRET, { expiresIn: '1h' });
    const upgraded = await fetch(`${base}/api/protected`, { headers: { Authorization: `Bearer ${legacy}` } });
    expect(upgraded.status).toBe(200);
    expect(upgraded.headers.get('x-auth-epoch')).toBe('1');
    expect(upgraded.headers.get('x-auth-generation')).toBe('1');
    const refreshed = upgraded.headers.get('x-refresh-token');
    expect(refreshed).toBeTruthy();
    expect((await fetch(`${base}/api/protected`, { headers: { Authorization: `Bearer ${legacy}` } })).status).toBe(401);
    expect((await fetch(`${base}/api/protected`, { headers: { Authorization: `Bearer ${refreshed!}` } })).status).toBe(200);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await h.close();
  });

  it('rejects stale WS event/send/ACK/replay frames after logout and accepts a new login epoch', async () => {
    const h = await createHarness();
    const oldBinding = h.authority.issueLogin(h.user.id);
    const oldWs = await authenticate(h.url, token(h.user, oldBinding), oldBinding);
    const oldClosed = waitClose(oldWs);
    h.authority.revokeGeneration(h.user.id, oldBinding);
    oldWs.send(JSON.stringify({ action: 'sync', lastSeq: 0, ...oldBinding }));
    await expect(oldClosed).resolves.toMatchObject({ code: 4401 });

    const newBinding = h.authority.issueLogin(h.user.id);
    const next = await authenticate(h.url, token(h.user, newBinding), newBinding);
    const downstream = waitMessage(next); // server-side ACK carries the active binding
    const serverClient = [...h.wsServer.getClients()].find((client) => client.user?.sub === h.user.id);
    if (!serverClient) throw new Error('authenticated server client missing');
    h.wsServer.sendTo(serverClient.ws, { data: { type: 'chat_ack', client_msg_id: 'c1', server_recv_ts: Date.now() } });
    await expect(downstream).resolves.toMatchObject({
      ...newBinding,
      data: { type: 'chat_ack', client_msg_id: 'c1' },
    });
    next.close();
    await h.close();
  });

  it('logging out one generation closes only that socket and keeps the other login connected', async () => {
    const h = await createHarness();
    const web = h.authority.issueLogin(h.user.id);
    const phone = h.authority.issueLogin(h.user.id);
    const webWs = await authenticate(h.url, token(h.user, web), web);
    const phoneWs = await authenticate(h.url, token(h.user, phone), phone);
    const webClosed = waitClose(webWs);
    let phoneClosed = false;
    phoneWs.once('close', () => { phoneClosed = true; });

    h.authority.revokeGeneration(h.user.id, web);
    h.wsServer.disconnectUser(h.user.id, undefined, web.generation);
    await expect(webClosed).resolves.toMatchObject({ code: 4401, reason: 'Authentication generation revoked' });

    const downstream = waitMessage(phoneWs);
    const phoneClient = [...h.wsServer.getClients()].find((client) => client.user?.generation === phone.generation);
    if (!phoneClient) throw new Error('phone client missing');
    h.wsServer.sendTo(phoneClient.ws, { data: { type: 'chat_ack', client_msg_id: 'c2', server_recv_ts: Date.now() } });
    await expect(downstream).resolves.toMatchObject({ ...phone, data: { type: 'chat_ack', client_msg_id: 'c2' } });
    expect(phoneClosed).toBe(false);
    phoneWs.close();
    await h.close();
  });

  it('rejects an auth frame whose claimed binding differs from its JWT', async () => {
    const h = await createHarness();
    const binding = h.authority.issueLogin(h.user.id);
    const ws = new WebSocket(h.url);
    const closed = waitClose(ws);
    await waitOpen(ws);
    ws.send(JSON.stringify({ action: 'auth', token: token(h.user, binding), authEpoch: binding.authEpoch - 1, generation: binding.generation }));
    await expect(closed).resolves.toMatchObject({ code: 4401, reason: 'Authentication failed' });
    await h.close();
  });
});
