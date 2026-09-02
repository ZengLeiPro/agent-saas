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

describe('WebChannel durable active stream reconnect', () => {
  const channels: WebChannel[] = [];

  afterEach(async () => {
    for (const channel of channels) await channel.stop();
    channels.length = 0;
  });

  it('echoes requestId when durable replay recovers an active run without an in-memory buffer', async () => {
    const getActiveBySession = vi.fn().mockResolvedValue({
      runId: 'run-durable-only',
      sessionId: 'session-durable-only',
      userId: 'admin-1',
      status: 'running',
      metadata: { streamId: 'stream-durable-only' },
    });
    const channel = new WebChannel({
      agentCwd: '/tmp/workspace',
      enqueueRuntime: { runStore: { getActiveBySession } } as any,
    }, noopDispatch);
    channels.push(channel);
    const ws = new FakeWebSocket();

    await (channel as any).handleResumeAsync(
      {
        ws,
        user: { sub: 'admin-1', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID },
        alive: true,
        lastActivityAt: Date.now(),
      },
      {
        action: 'resume',
        sessionId: 'session-durable-only',
        requestId: 'resume-request-durable-only',
        lastEventId: 0,
        skipReplay: true,
      },
    );

    expect(ws.sent[0]).toMatchObject({
      data: {
        type: 'active_stream',
        sessionId: 'session-durable-only',
        active: true,
        streamId: 'stream-durable-only',
        runId: 'run-durable-only',
        status: 'running',
        requestId: 'resume-request-durable-only',
      },
    });
  });
});
