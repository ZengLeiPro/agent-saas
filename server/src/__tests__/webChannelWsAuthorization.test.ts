import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type { AgentRunDispatch, InteractionResponse } from '../agent/types.js';
import { WebChannel } from '../channels/web/channel.js';
import { interactionStore } from '../channels/web/interactionStore.js';
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

  it('auth disabled lets the same anonymous WS answer ask_user and completes the run', async () => {
    const sessionId = 'anonymous-interaction-session';
    const interactionId = 'anonymous-ask-user';
    let interactionResponse: InteractionResponse | undefined;
    const dispatch: AgentRunDispatch = async function* (_message, _context, _options, hooks) {
      await hooks!.onSessionStart!(sessionId);
      yield { type: 'session_init', sessionId };
      interactionResponse = await hooks!.onInteraction!({
        type: 'ask_user',
        interactionId,
        sessionId,
        questions: [{
          question: '是否继续？',
          header: '确认',
          options: [{ label: '继续', description: '继续执行' }],
          multiSelect: false,
        }],
      });
      yield { type: 'done' };
    };
    const url = await startChannel(false, dispatch);
    const ws = new WebSocket(url);
    const messages: any[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));

    await waitOpen(ws);
    await waitUntil(() => messages.some((message) => message.data?.type === 'auth_ok'));
    ws.send(JSON.stringify({ action: 'chat', client_msg_id: 'anonymous-ask-chat', message: 'ask me' }));
    await waitUntil(() => messages.some((message) => message.data?.type === 'ask_user'));
    ws.send(JSON.stringify({
      action: 'respond', interactionId, answers: { choice: '继续' },
    }));

    await waitUntil(() => messages.some((message) => message.data?.type === 'respond_ok'));
    await waitUntil(() => messages.some((message) => message.data?.type === 'done'));
    expect(interactionResponse).toEqual({ answers: { choice: '继续' } });
    expect(interactionStore.get(interactionId)).toBeUndefined();
    expect(messages.some((message) => message.data?.type === 'respond_error')).toBe(false);
    const closed = waitClose(ws);
    ws.close();
    await closed;
  });

  it('auth disabled limits anonymous resume and abort to the WS that started the run', async () => {
    const sessionId = 'anonymous-control-session';
    const dispatch: AgentRunDispatch = async function* (_message, _context, options, hooks) {
      await hooks!.onSessionStart!(sessionId);
      yield { type: 'session_init', sessionId };
      await new Promise<void>((resolve) => {
        if (options?.abortController?.signal.aborted) resolve();
        else options?.abortController?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'done' };
    };
    const url = await startChannel(false, dispatch);
    const ownerWs = new WebSocket(url);
    const ownerMessages: any[] = [];
    ownerWs.on('message', (raw) => ownerMessages.push(JSON.parse(raw.toString())));
    await waitOpen(ownerWs);
    await waitUntil(() => ownerMessages.some((message) => message.data?.type === 'auth_ok'));
    ownerWs.send(JSON.stringify({ action: 'chat', client_msg_id: 'anonymous-control-chat', message: 'keep running' }));
    await waitUntil(() => ownerMessages.some((message) => message.data?.type === 'session'));
    const streamId = ownerMessages.find((message) => message.data?.type === 'stream_id')!.data.streamId;

    ownerWs.send(JSON.stringify({ action: 'resume', sessionId, lastEventId: 0, skipReplay: true }));
    await waitUntil(() => ownerMessages.some((message) => message.data?.type === 'active_stream'));
    expect(ownerMessages.filter((message) => message.data?.type === 'active_stream').at(-1)?.data)
      .toMatchObject({ sessionId, active: true, streamId });

    const otherWs = new WebSocket(url);
    const otherMessages: any[] = [];
    otherWs.on('message', (raw) => otherMessages.push(JSON.parse(raw.toString())));
    await waitOpen(otherWs);
    await waitUntil(() => otherMessages.some((message) => message.data?.type === 'auth_ok'));
    otherWs.send(JSON.stringify({ action: 'resume', sessionId, lastEventId: 0, skipReplay: true }));
    await waitUntil(() => otherMessages.some((message) => message.data?.type === 'active_stream'));
    expect(otherMessages.filter((message) => message.data?.type === 'active_stream').at(-1)?.data)
      .toMatchObject({ sessionId, active: false });
    otherWs.send(JSON.stringify({ action: 'abort', streamId }));
    await waitUntil(() => otherMessages.some((message) => message.data?.type === 'error'));
    expect(otherMessages.filter((message) => message.data?.type === 'error').at(-1)?.data)
      .toEqual({ type: 'error', message: 'Access denied' });

    ownerWs.send(JSON.stringify({ action: 'abort', streamId }));
    await waitUntil(() => ownerMessages.some((message) => message.data?.type === 'abort_ok'));
    const ownerClosed = waitClose(ownerWs);
    const otherClosed = waitClose(otherWs);
    ownerWs.close();
    otherWs.close();
    await Promise.all([ownerClosed, otherClosed]);
  });

  it('auth disabled treats a PG-defaulted ownerless run as anonymous but not a non-default tenant run', async () => {
    const runStore = new MemoryRunStore();
    await runStore.upsertPending({
      runId: 'default-anonymous-run', sessionId: 'default-anonymous-session',
      tenantId: 'pantheon', channel: 'web',
    });
    await runStore.upsertPending({
      runId: 'tenant-sensitive-run', sessionId: 'tenant-sensitive-session',
      tenantId: 'tenant-sensitive', channel: 'web',
    });
    const channel = new WebChannel({
      authEnabled: false,
      enqueueRuntime: { scheduler: {} as any, runStore, sessionCatalog: {} as any, enabled: true },
    }, async function* () { yield { type: 'done' }; });
    channels.push(channel);
    const ws = new FakeWebSocket();
    const client = wsClient(ws);
    for (const [streamId, runId, sessionId] of [
      ['default-stream', 'default-anonymous-run', 'default-anonymous-session'],
      ['sensitive-stream', 'tenant-sensitive-run', 'tenant-sensitive-session'],
    ]) {
      (channel as any).activeStreams.set(streamId, {
        controller: new AbortController(), ws, runId, sessionId,
      });
      (channel as any).eventBufferStore.create(sessionId);
    }

    await (channel as any).handleResumeAsync(client, {
      action: 'resume', sessionId: 'default-anonymous-session', lastEventId: 0, skipReplay: true,
    });
    expect(ws.sent.at(-1)?.data).toMatchObject({
      type: 'active_stream', sessionId: 'default-anonymous-session', active: true,
    });
    await (channel as any).handleAbortAsync(client, { action: 'abort', runId: 'default-anonymous-run' });
    expect(ws.sent.at(-1)?.data).toMatchObject({ type: 'abort_ok', runId: 'default-anonymous-run' });

    await (channel as any).handleResumeAsync(client, {
      action: 'resume', sessionId: 'tenant-sensitive-session', lastEventId: 0, skipReplay: true,
    });
    expect(ws.sent.at(-1)?.data).toMatchObject({
      type: 'active_stream', sessionId: 'tenant-sensitive-session', active: false,
    });
    await (channel as any).handleAbortAsync(client, { action: 'abort', runId: 'tenant-sensitive-run' });
    expect(ws.sent.at(-1)?.data).toEqual({ type: 'error', message: 'Access denied' });
    expect((await runStore.get('tenant-sensitive-run'))?.status).toBe('pending');
  });

  it.each([
    ['explicit auth', { authEnabled: true }],
    ['legacy jwtSecret-only auth', { jwtSecret: 'legacy-auth-secret' }],
  ])('%s rejects an ownerless interaction even on its bound WS', async (_label, config) => {
    const channel = new WebChannel(config, async function* () { yield { type: 'done' }; });
    channels.push(channel);
    const ws = new FakeWebSocket();
    const interactionId = `ownerless-${_label}`;
    const pending = interactionStore.create(interactionId, 'ask_user', { boundWebSocket: ws as any });

    (channel as any).handleRespond(wsClient(ws), {
      action: 'respond', interactionId, answers: { choice: 'continue' },
    });

    expect(ws.sent.at(-1)?.data).toEqual({ type: 'respond_error', interactionId, error: 'Access denied' });
    expect(interactionStore.get(interactionId)).toBeTruthy();
    interactionStore.resolve(interactionId, { answers: { choice: 'cleanup' } });
    await pending;
  });

  it('auth enabled rejects ownerless resume and abort even from the originally bound WS', async () => {
    const channel = new WebChannel({ authEnabled: true }, async function* () { yield { type: 'done' }; });
    channels.push(channel);
    const ws = new FakeWebSocket();
    const client = wsClient(ws);
    const sessionId = 'auth-ownerless-session';
    const streamId = 'auth-ownerless-stream';
    (channel as any).activeStreams.set(streamId, {
      controller: new AbortController(), ws, sessionId,
    });
    (channel as any).eventBufferStore.create(sessionId);

    await (channel as any).handleResumeAsync(client, {
      action: 'resume', sessionId, lastEventId: 0, skipReplay: true,
    });
    expect(ws.sent.at(-1)?.data).toMatchObject({ type: 'active_stream', sessionId, active: false });

    await (channel as any).handleAbortAsync(client, { action: 'abort', streamId });
    expect(ws.sent.at(-1)?.data).toEqual({ type: 'error', message: 'Access denied' });
    expect((channel as any).activeStreams.get(streamId).controller.signal.aborted).toBe(false);
  });

  it('auth enabled rejects a cross-subject interaction response without consuming pending state', async () => {
    const channel = new WebChannel({ authEnabled: true }, async function* () { yield { type: 'done' }; });
    channels.push(channel);
    const ws = new FakeWebSocket();
    const interactionId = 'authenticated-cross-subject';
    const pending = interactionStore.create(interactionId, 'ask_user', { userId: 'owner-user' });

    (channel as any).handleRespond(wsClient(ws, {
      sub: 'attacker-user', username: 'attacker', role: 'user', tenantId: 'tenant-a',
    }), { action: 'respond', interactionId, answers: { choice: 'steal' } });

    expect(ws.sent.at(-1)?.data).toEqual({ type: 'respond_error', interactionId, error: 'Access denied' });
    expect(interactionStore.get(interactionId)).toBeTruthy();
    interactionStore.resolve(interactionId, { answers: { choice: 'cleanup' } });
    await pending;
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
