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

  it('跨进程 ownerless buffer 不得覆盖 durable run 的授权运行态', async () => {
    const getActiveBySession = vi.fn().mockResolvedValue({
      runId: 'taskboard-run-cross-process',
      sessionId: 'taskboard-session-cross-process',
      userId: 'admin-1',
      tenantId: 'kaiyan',
      status: 'running',
      metadata: {},
    });
    const channel = new WebChannel(
      {
        authEnabled: true,
        agentCwd: '/tmp/workspace',
        enqueueRuntime: { runStore: { getActiveBySession } } as never,
      },
      noopDispatch,
    );
    channels.push(channel);
    const ws = new FakeWebSocket();
    // PG NOTIFY 投影可能先于当前 Web 进程的本地 stream 到达，此时 buffer 没有 owner。
    (channel as any).eventBufferStore.create('taskboard-session-cross-process');

    await (channel as any).handleResumeAsync(
      {
        ws,
        user: { sub: 'admin-1', username: 'admin', role: 'admin', tenantId: 'kaiyan' },
        alive: true,
        lastActivityAt: Date.now(),
      },
      {
        action: 'resume',
        sessionId: 'taskboard-session-cross-process',
        requestId: 'resume-cross-process',
        lastEventId: 0,
        skipReplay: true,
      },
    );

    expect(ws.sent[0]).toEqual({
      data: {
        type: 'active_stream',
        sessionId: 'taskboard-session-cross-process',
        active: true,
        streamId: 'taskboard-run-cross-process',
        runId: 'taskboard-run-cross-process',
        status: 'running',
        requestId: 'resume-cross-process',
      },
    });

    const foreignWs = new FakeWebSocket();
    await (channel as any).handleResumeAsync(
      {
        ws: foreignWs,
        user: { sub: 'other-user', username: 'other', role: 'user', tenantId: 'kaiyan' },
        alive: true,
        lastActivityAt: Date.now(),
      },
      {
        action: 'resume',
        sessionId: 'taskboard-session-cross-process',
        requestId: 'resume-cross-process-foreign',
        lastEventId: 0,
        skipReplay: true,
      },
    );
    expect(foreignWs.sent[0]).toEqual({
      data: {
        type: 'active_stream',
        sessionId: 'taskboard-session-cross-process',
        active: false,
        requestId: 'resume-cross-process-foreign',
      },
    });
  });
});
