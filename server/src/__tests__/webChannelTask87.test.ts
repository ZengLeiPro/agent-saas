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
});
