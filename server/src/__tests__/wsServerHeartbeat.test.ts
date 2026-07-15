import http from 'http';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { WsServer } from '../channels/web/wsServer.js';

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (err) {
        reject(err);
      }
    });
    ws.once('error', reject);
  });
}

async function waitUntil(predicate: () => boolean, { timeoutMs = 2_000, intervalMs = 10 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function withWsServer<T>(fn: (args: { url: string; wsServer: WsServer }) => Promise<T>): Promise<T> {
  const server = http.createServer((_req, res) => res.end('ok'));
  const wsServer = new WsServer({ jwtSecret: 'test-secret', pingIntervalMs: 60_000 });
  wsServer.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  const token = jwt.sign({ sub: 'user-1', username: 'alice', role: 'user' }, 'test-secret');
  try {
    return await fn({ url: `ws://127.0.0.1:${address.port}/ws?token=${token}`, wsServer });
  } finally {
    wsServer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('WsServer heartbeat', () => {
  it('accepts an unauthenticated deployment probe without registering a user client', async () => {
    await withWsServer(async ({ url, wsServer }) => {
      const probeUrl = new URL(url);
      probeUrl.search = '?probe=1';
      const ws = new WebSocket(probeUrl);
      const messagePromise = waitMessage(ws);

      await waitOpen(ws);
      await expect(messagePromise).resolves.toEqual({ data: { type: 'pong', probe: true } });
      expect(wsServer.clientCount).toBe(0);
    });
  });

  it('sends lightweight pong before metadata sync replay', async () => {
    await withWsServer(async ({ url, wsServer }) => {
      wsServer.userEventLog.push('user-1', { type: 'session_updated', sessionId: 'session-1' });

      const ws = new WebSocket(url);
      const messages: any[] = [];
      ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
      await waitOpen(ws);
      ws.send(JSON.stringify({ action: 'ping', lastSeq: 0, clientTs: Date.now() }));

      await waitUntil(() => messages.length >= 2);
      expect(messages[0]).toEqual({
        data: { type: 'pong', seq: 1 },
      });
      expect(messages[1]).toEqual({
        data: {
          type: 'sync_ok',
          seq: 1,
          events: [
            {
              seq: 1,
              timestamp: expect.any(Number),
              event: { type: 'session_updated', sessionId: 'session-1' },
            },
          ],
        },
      });

      ws.close();
    });
  });
});
