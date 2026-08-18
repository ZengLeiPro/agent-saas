import { afterEach, describe, expect, it } from 'vitest';

import { WebChannel } from '../channels/web/channel.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import { FakeWebSocket, flushMicrotasks, wsClient } from './webChannelTestHelpers.js';

const USER = {
  sub: 'task87-user',
  username: 'task87_user',
  role: 'user' as const,
  tenantId: 'task87-tenant',
};

describe('跨进程 durable interaction 实时投影（TASK-87）', () => {
  const channels: WebChannel[] = [];

  afterEach(async () => {
    for (const channel of channels) await channel.stop();
    channels.length = 0;
  });

  it('interaction_requested 到达 Web 进程后，当前会话无需刷新即可恢复 ask_user', async () => {
    const channel = new WebChannel(
      { executionConfig: createExecutionConfig() },
      async function* () { yield { type: 'done' as const }; },
    );
    channels.push(channel);

    const ws = new FakeWebSocket();
    const userEvents: any[] = [];
    (channel as any).eventBus = {
      emitReply: (target: FakeWebSocket, data: object) => target.send(JSON.stringify({ data })),
      emitSession: () => undefined,
      emitDual: () => undefined,
      emitUser: (userId: string, data: object) => {
        if (userId !== USER.sub) return;
        userEvents.push(data);
        ws.send(JSON.stringify({ data }));
      },
    };

    const sessionId = 'session-task-87';
    (channel as any).publishRuntimePlatformEvent({
      id: 'event-task-87-ask',
      timestamp: '2026-08-18T08:00:00.000Z',
      type: 'interaction_requested',
      sessionId,
      runId: 'run-task-87',
      toolCallId: 'call-task-87',
      interactionId: 'ask-task-87',
      interactionType: 'ask_user',
      userId: USER.sub,
      toolName: 'AskUserQuestion',
      questions: [{
        question: '是否继续？',
        header: '确认',
        options: [{ label: '继续', description: '继续执行' }],
        multiSelect: false,
      }],
    });

    expect(userEvents).toContainEqual({
      type: 'stream_started',
      sessionId,
      streamId: 'run-task-87',
      runId: 'run-task-87',
    });
    expect((channel as any).eventBufferStore.get(sessionId).userId).toBe(USER.sub);

    await (channel as any).handleResumeAsync(wsClient(ws, USER), {
      action: 'resume', sessionId, lastEventId: 0, skipReplay: false,
    });
    await flushMicrotasks();

    const pending = ws.sent.find((message) => message.data?.type === 'pending_interactions');
    expect(pending?.data.interactions).toContainEqual(expect.objectContaining({
      type: 'ask_user',
      interactionId: 'ask-task-87',
      questions: [{
        question: '是否继续？',
        header: '确认',
        options: [{ label: '继续', description: '继续执行' }],
        multiSelect: false,
      }],
    }));
  });

  it('interaction_requested 补写既有 buffer owner，拒绝跨用户 resume', async () => {
    const channel = new WebChannel(
      { executionConfig: createExecutionConfig() },
      async function* () { yield { type: 'done' as const }; },
    );
    channels.push(channel);

    const ownerWs = new FakeWebSocket();
    const attackerWs = new FakeWebSocket();
    (channel as any).eventBus = {
      emitReply: (target: FakeWebSocket, data: object) => target.send(JSON.stringify({ data })),
      emitSession: () => undefined,
      emitDual: () => undefined,
      emitUser: (userId: string, data: object) => {
        if (userId === USER.sub) ownerWs.send(JSON.stringify({ data }));
      },
    };

    const sessionId = 'session-task-87-owner';
    (channel as any).eventBufferStore.create(sessionId);
    (channel as any).eventBufferStore.push(sessionId, JSON.stringify({ type: 'session', sessionId }));
    (channel as any).publishRuntimePlatformEvent({
      id: 'event-task-87-owner',
      timestamp: '2026-08-18T08:00:00.000Z',
      type: 'interaction_requested',
      sessionId,
      runId: 'run-task-87-owner',
      interactionId: 'ask-task-87-owner',
      interactionType: 'ask_user',
      userId: USER.sub,
      questions: [],
    });

    expect((channel as any).eventBufferStore.get(sessionId).userId).toBe(USER.sub);

    const attacker = {
      sub: 'task87-attacker',
      username: 'task87_attacker',
      role: 'user' as const,
      tenantId: 'other-tenant',
    };
    await (channel as any).handleResumeAsync(wsClient(attackerWs, attacker), {
      action: 'resume', sessionId, lastEventId: 0, skipReplay: false,
    });
    expect(attackerWs.sent).toContainEqual({
      data: expect.objectContaining({ type: 'active_stream', sessionId, active: false }),
    });
    expect(attackerWs.sent.some((message) => message.data?.type === 'pending_interactions')).toBe(false);

    await (channel as any).handleResumeAsync(wsClient(ownerWs, USER), {
      action: 'resume', sessionId, lastEventId: 0, skipReplay: false,
    });
    await flushMicrotasks();
    expect(ownerWs.sent.some((message) => message.data?.type === 'pending_interactions')).toBe(true);
  });
});
