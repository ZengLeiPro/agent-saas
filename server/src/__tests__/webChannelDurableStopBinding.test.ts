import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRunDispatch } from '../agent/types.js';
import { WebChannel } from '../channels/web/channel.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

class FakeWebSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];

  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }
}

const noopDispatch: AgentRunDispatch = async function* () {
  yield { type: 'done' };
};

describe('WebChannel durable stop binding', () => {
  const channels: WebChannel[] = [];

  afterEach(async () => {
    await Promise.all(channels.map((channel) => channel.stop()));
    channels.length = 0;
  });

  it('活跃 buffer 没有本地 stream 时仍返回 durable run 标识供前端停止', async () => {
    const getActiveBySession = vi.fn().mockResolvedValue({
      runId: 'taskboard-run-1',
      sessionId: 'taskboard-session-1',
      userId: 'admin-1',
      tenantId: DEFAULT_TENANT_ID,
      status: 'running',
      metadata: {},
    });
    const channel = new WebChannel(
      {
        agentCwd: '/tmp/workspace',
        enqueueRuntime: { runStore: { getActiveBySession } } as never,
      },
      noopDispatch,
    );
    channels.push(channel);
    const ws = new FakeWebSocket();
    (channel as any).eventBufferStore.create('taskboard-session-1', 'admin-1');

    await (channel as any).handleResumeAsync(
      {
        ws,
        user: { sub: 'admin-1', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID },
        alive: true,
        lastActivityAt: Date.now(),
      },
      {
        action: 'resume',
        sessionId: 'taskboard-session-1',
        requestId: 'resume-taskboard-run',
        lastEventId: 0,
        skipReplay: true,
      },
    );

    expect(ws.sent[0]).toEqual({
      data: {
        type: 'active_stream',
        sessionId: 'taskboard-session-1',
        active: true,
        streamId: 'taskboard-run-1',
        runId: 'taskboard-run-1',
        status: 'running',
        requestId: 'resume-taskboard-run',
      },
    });
  });
});
