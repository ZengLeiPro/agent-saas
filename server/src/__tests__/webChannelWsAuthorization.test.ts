import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type { AgentRunDispatch } from '../agent/types.js';
import { WebChannel } from '../channels/web/channel.js';
import { chatMessage, FakeWebSocket, MemoryRunStore, wsClient } from './webChannelTestHelpers.js';

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP server did not bind a TCP port');
  return address.port;
}

describe('WebChannel WebSocket auth-mode chat boundary', () => {
  const channels: WebChannel[] = [];
  const servers: http.Server[] = [];
  const workspaces: string[] = [];

  afterEach(async () => {
    for (const channel of channels) await channel.stop();
    channels.length = 0;
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    servers.length = 0;
    for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true });
    workspaces.length = 0;
  });

  async function startChannel(authEnabled: boolean, dispatch: AgentRunDispatch): Promise<string> {
    const agentCwd = await mkdtemp(join(tmpdir(), 'web-channel-ws-auth-'));
    workspaces.push(agentCwd);
    const channel = new WebChannel({
      authEnabled,
      jwtSecret: authEnabled ? 'web-channel-ws-auth-test-secret' : undefined,
      agentCwd,
    }, dispatch);
    channels.push(channel);
    await channel.start({} as any);

    const server = http.createServer();
    servers.push(server);
    channel.attachToServer(server);
    const port = await listen(server);
    return `ws://127.0.0.1:${port}/ws`;
  }

  it('auth disabled accepts an anonymous chat and dispatches it through the existing chat chain', async () => {
    const dispatched: Array<{ content: string; hasUser: boolean }> = [];
    const dispatch: AgentRunDispatch = async function* (message, context) {
      dispatched.push({ content: message.content, hasUser: Boolean(context.user) });
      yield { type: 'done' };
    };
    const url = await startChannel(false, dispatch);
    const ws = new WebSocket(url);
    const messages: any[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));

    await waitOpen(ws);
    await waitUntil(() => messages.some((message) => message.data?.type === 'auth_ok'));
    ws.send(JSON.stringify({
      action: 'chat',
      client_msg_id: 'anonymous-chat-1',
      message: 'anonymous hello',
    }));

    await waitUntil(() => dispatched.length === 1 && messages.some((message) => message.data?.type === 'done'));
    expect(dispatched).toEqual([{ content: 'anonymous hello', hasUser: false }]);
    expect(messages.map((message) => message.data?.type)).toEqual(expect.arrayContaining([
      'auth_ok',
      'chat_ack',
      'stream_id',
      'done',
    ]));
    expect(messages.some((message) => message.data?.type === 'chat_rejected')).toBe(false);
    const closed = waitClose(ws);
    ws.close();
    await closed;
  });

  it('auth enabled rejects a chat frame from a connection without a user principal', async () => {
    let dispatchCount = 0;
    const dispatch: AgentRunDispatch = async function* () {
      dispatchCount += 1;
      yield { type: 'done' };
    };
    const url = await startChannel(true, dispatch);
    const ws = new WebSocket(url);
    const closed = waitClose(ws);

    await waitOpen(ws);
    ws.send(JSON.stringify({
      action: 'chat',
      client_msg_id: 'unauthenticated-chat-1',
      message: 'must not dispatch',
    }));

    await expect(closed).resolves.toEqual({ code: 4401, reason: 'Authentication required' });
    expect(dispatchCount).toBe(0);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('auth disabled replays a PG-defaulted anonymous durable chat after reconnect when userId is %s', async (_label, missingUserId) => {
    const runStore = new MemoryRunStore();
    const durableRun = await runStore.upsertPending({
      runId: `anonymous-run-${_label}`,
      sessionId: `anonymous-session-${_label}`,
      tenantId: 'pantheon',
      model: 'test-model',
      channel: 'web',
      idempotencyKey: `anonymous-replay-${_label}`,
    });
    runStore.records.set(durableRun.runId, {
      ...durableRun,
      userId: missingUserId,
      status: 'completed',
    } as any);
    // Model the PG lookup result directly: its tenant default must not turn an anonymous
    // no-auth run into a tenant-scoped principal.
    runStore.findByIdempotencyKey = async (_userId, key) => (
      [...runStore.records.values()].find((record) => record.idempotencyKey === key) ?? null
    );
    const channel = new WebChannel({
      authEnabled: false,
      enqueueRuntime: {
        scheduler: {} as any,
        runStore,
        sessionCatalog: {} as any,
        enabled: true,
      },
    }, async function* () { yield { type: 'done' }; });
    channels.push(channel);

    const replay = async (ws: FakeWebSocket) => {
      await (channel as any).processChatMessage(wsClient(ws), chatMessage({
        client_msg_id: `anonymous-replay-${_label}`,
        message: 'retry after disconnect',
      }));
      return ws.sent.map((message) => message.data);
    };

    const disconnectedAttempt = await replay(new FakeWebSocket());
    const retryAttempt = await replay(new FakeWebSocket());
    const stableMessages = (messages: any[]) => messages.map(({ server_recv_ts: _, ...message }) => message);
    expect(stableMessages(retryAttempt)).toEqual(stableMessages(disconnectedAttempt));
    expect(retryAttempt).toEqual([
      expect.objectContaining({
        type: 'chat_ack',
        client_msg_id: `anonymous-replay-${_label}`,
        status: 'completed',
        runId: `anonymous-run-${_label}`,
        sessionId: `anonymous-session-${_label}`,
      }),
      {
        type: 'session',
        sessionId: `anonymous-session-${_label}`,
        client_msg_id: `anonymous-replay-${_label}`,
      },
    ]);
    expect(retryAttempt.some((message) => message.type === 'chat_rejected')).toBe(false);
  });

  it('auth enabled rejects replay of a PG-defaulted durable run without an owner', async () => {
    const runStore = new MemoryRunStore();
    const durableRun = await runStore.upsertPending({
      runId: 'anonymous-auth-run',
      sessionId: 'anonymous-auth-session',
      tenantId: 'pantheon',
      model: 'test-model',
      channel: 'web',
      idempotencyKey: 'anonymous-auth-replay',
    });
    runStore.records.set(durableRun.runId, { ...durableRun, userId: null } as any);
    runStore.findByIdempotencyKey = async () => runStore.records.get(durableRun.runId) ?? null;
    const channel = new WebChannel({
      authEnabled: true,
      enqueueRuntime: {
        scheduler: {} as any,
        runStore,
        sessionCatalog: {} as any,
        enabled: true,
      },
    }, async function* () { yield { type: 'done' }; });
    channels.push(channel);
    const ws = new FakeWebSocket();

    await (channel as any).processChatMessage(wsClient(ws), chatMessage({
      client_msg_id: 'anonymous-auth-replay',
      message: 'must reject without principal',
    }));

    expect(ws.sent).toEqual([{ data: expect.objectContaining({
      type: 'chat_rejected',
      reason_code: 'access_denied',
    }) }]);
  });

  it('auth disabled still rejects non-default tenant or owner scoped durable runs', async () => {
    const runStore = new MemoryRunStore();
    await runStore.upsertPending({
      runId: 'tenant-run',
      sessionId: 'tenant-session',
      tenantId: 'tenant-a',
      model: 'test-model',
      channel: 'web',
      idempotencyKey: 'tenant-replay',
    });
    await runStore.upsertPending({
      runId: 'owned-run',
      sessionId: 'owned-session',
      userId: 'owner-a',
      tenantId: 'pantheon',
      model: 'test-model',
      channel: 'web',
      idempotencyKey: 'owner-replay',
    });
    runStore.findByIdempotencyKey = async (_userId, key) => (
      [...runStore.records.values()].find((record) => record.idempotencyKey === key) ?? null
    );
    const channel = new WebChannel({
      authEnabled: false,
      enqueueRuntime: {
        scheduler: {} as any,
        runStore,
        sessionCatalog: {} as any,
        enabled: true,
      },
    }, async function* () { yield { type: 'done' }; });
    channels.push(channel);

    for (const clientMsgId of ['tenant-replay', 'owner-replay']) {
      const ws = new FakeWebSocket();
      await (channel as any).processChatMessage(wsClient(ws), chatMessage({
        client_msg_id: clientMsgId,
        message: 'must reject scoped target',
      }));
      expect(ws.sent).toEqual([{ data: expect.objectContaining({
        type: 'chat_rejected',
        reason_code: 'access_denied',
      }) }]);
    }
  });
});
