import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebChannel } from '../channels/web/channel.js';
import type { AgentRunDispatch } from '../agent/types.js';

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

describe('WebChannel active stream reconnect', () => {
  const channels: WebChannel[] = [];

  afterEach(async () => {
    for (const channel of channels) {
      await channel.stop();
    }
    channels.length = 0;
  });

  function createChannel(): WebChannel {
    const channel = new WebChannel({ agentCwd: '/tmp/workspace' }, noopDispatch);
    channels.push(channel);
    return channel;
  }

  it('keeps active stream metadata on socket close so resume can return the streamId', async () => {
    const channel = createChannel();
    const oldWs = new FakeWebSocket();
    const controller = new AbortController();
    const connectionAbortController = new AbortController();

    (channel as any).activeStreams.set('stream-1', {
      controller,
      userId: 'admin-1',
      ws: oldWs,
      sessionId: 'session-1',
    });
    (channel as any).eventBufferStore.create('session-1', 'admin-1');

    (channel as any).handleActiveStreamSocketClose(
      'stream-1',
      oldWs,
      connectionAbortController,
      new Set<string>(),
    );

    expect(connectionAbortController.signal.aborted).toBe(true);
    expect((channel as any).activeStreams.has('stream-1')).toBe(true);
    expect(await channel.getStreamStatus('session-1')).toEqual({
      active: true,
      streamId: 'stream-1',
    });
  });

  it('resume replays buffered events and reports the active streamId', () => {
    const channel = createChannel();
    const oldWs = new FakeWebSocket();
    const newWs = new FakeWebSocket();
    const onSpy = vi.spyOn(newWs, 'on');

    (channel as any).activeStreams.set('stream-2', {
      controller: new AbortController(),
      userId: 'admin-1',
      ws: oldWs,
      sessionId: 'session-2',
    });
    (channel as any).eventBufferStore.create('session-2', 'admin-1');
    (channel as any).eventBufferStore.push('session-2', JSON.stringify({
      type: 'text',
      content: 'replayed',
    }));

    (channel as any).handleResume(
      {
        ws: newWs,
        user: { sub: 'admin-1', username: 'admin', role: 'admin' },
        alive: true,
        lastActivityAt: Date.now(),
      },
      { action: 'resume', sessionId: 'session-2', lastEventId: 0 },
    );

    expect(newWs.sent[0]).toEqual({
      data: {
        type: 'active_stream',
        sessionId: 'session-2',
        active: true,
        streamId: 'stream-2',
        status: 'running',
      },
    });
    expect(newWs.sent[1]).toEqual({
      eventId: 1,
      data: { type: 'text', content: 'replayed' },
    });
    expect(onSpy).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('keeps resume subscription when scheduler session_init reuses an active buffer', () => {
    const channel = createChannel();
    const ws = new FakeWebSocket();

    (channel as any).activeStreams.set('stream-3', {
      controller: new AbortController(),
      userId: 'admin-1',
      ws: { OPEN: 1, readyState: 3 },
      sessionId: 'session-3',
      runId: 'run-3',
    });
    (channel as any).eventBufferStore.create('session-3', 'admin-1');

    (channel as any).handleResume(
      {
        ws,
        user: { sub: 'admin-1', username: 'admin', role: 'admin' },
        alive: true,
        lastActivityAt: Date.now(),
      },
      { action: 'resume', sessionId: 'session-3', lastEventId: 0 },
    );

    (channel as any).eventBufferStore.create('session-3', 'admin-1');
    (channel as any).eventBufferStore.push('session-3', JSON.stringify({
      type: 'text',
      content: 'still live',
    }));

    expect(ws.sent).toContainEqual({
      eventId: 1,
      data: { type: 'text', content: 'still live' },
    });
  });

  it('does not subscribe the origin socket twice when resume is sent while direct-bound', () => {
    const channel = createChannel();
    const ws = new FakeWebSocket();

    (channel as any).activeStreams.set('stream-4', {
      controller: new AbortController(),
      userId: 'admin-1',
      ws,
      sessionId: 'session-4',
      runId: 'run-4',
    });
    (channel as any).wsActiveStream.set(ws, 'stream-4');
    (channel as any).eventBufferStore.create('session-4', 'admin-1');

    (channel as any).handleResume(
      {
        ws,
        user: { sub: 'admin-1', username: 'admin', role: 'admin' },
        alive: true,
        lastActivityAt: Date.now(),
      },
      { action: 'resume', sessionId: 'session-4', lastEventId: 0 },
    );

    (channel as any).eventBufferStore.push('session-4', JSON.stringify({
      type: 'text',
      content: 'must not echo through resume listener',
    }));

    expect(ws.sent).toEqual([
      {
        data: {
          type: 'active_stream',
          sessionId: 'session-4',
          active: true,
          streamId: 'stream-4',
          runId: 'run-4',
          status: 'running',
        },
      },
    ]);
  });

  it('does not create a ghost buffer for background events with empty projection', () => {
    const channel = createChannel();

    // hand_health_changed 投影为空且非 terminal —— 不应为已结束会话创建 active buffer
    channel.publishRuntimePlatformEvent({
      id: 'evt-health-1',
      timestamp: new Date().toISOString(),
      type: 'hand_health_changed',
      sessionId: 'session-ghost',
      handId: 'session-ghost:agent-saas-acs',
      healthy: false,
      detail: 'health_probe_failed',
    } as any);

    expect((channel as any).eventBufferStore.get('session-ghost')).toBeUndefined();
    expect((channel as any).eventBufferStore.isActive('session-ghost')).toBe(false);
  });

  it('resume treats an active buffer as inactive when durable runStore has no active run', async () => {
    const getActiveBySession = vi.fn().mockResolvedValue(null);
    const channel = new WebChannel({
      agentCwd: '/tmp/workspace',
      enqueueRuntime: {
        runStore: { getActiveBySession },
      } as any,
    }, noopDispatch);
    channels.push(channel);
    const ws = new FakeWebSocket();

    // 幽灵 buffer：active 但 PG 无任何活跃 run
    (channel as any).eventBufferStore.create('session-ghost-2', 'admin-1');
    expect((channel as any).eventBufferStore.isActive('session-ghost-2')).toBe(true);

    await (channel as any).handleResumeAsync(
      {
        ws,
        user: { sub: 'admin-1', username: 'admin', role: 'admin' },
        alive: true,
        lastActivityAt: Date.now(),
      },
      { action: 'resume', sessionId: 'session-ghost-2', lastEventId: 0, skipReplay: true },
    );

    expect(getActiveBySession).toHaveBeenCalledWith('session-ghost-2');
    // 必须回 inactive，且幽灵 buffer 被收口
    expect(ws.sent).toContainEqual({
      data: { type: 'active_stream', sessionId: 'session-ghost-2', active: false },
    });
    expect((channel as any).eventBufferStore.isActive('session-ghost-2')).toBe(false);
  });

  it('resume still reports active when durable runStore confirms a live run', async () => {
    const getActiveBySession = vi.fn().mockResolvedValue({
      runId: 'run-live',
      sessionId: 'session-live',
      status: 'running',
      metadata: {},
    });
    const channel = new WebChannel({
      agentCwd: '/tmp/workspace',
      enqueueRuntime: {
        runStore: { getActiveBySession },
      } as any,
    }, noopDispatch);
    channels.push(channel);
    const ws = new FakeWebSocket();

    (channel as any).activeStreams.set('stream-live', {
      controller: new AbortController(),
      userId: 'admin-1',
      ws: new FakeWebSocket(),
      sessionId: 'session-live',
      runId: 'run-live',
    });
    (channel as any).eventBufferStore.create('session-live', 'admin-1');

    await (channel as any).handleResumeAsync(
      {
        ws,
        user: { sub: 'admin-1', username: 'admin', role: 'admin' },
        alive: true,
        lastActivityAt: Date.now(),
      },
      { action: 'resume', sessionId: 'session-live', lastEventId: 0, skipReplay: true },
    );

    expect(ws.sent).toContainEqual({
      data: {
        type: 'active_stream',
        sessionId: 'session-live',
        active: true,
        streamId: 'stream-live',
        runId: 'run-live',
        status: 'running',
      },
    });
    expect((channel as any).eventBufferStore.isActive('session-live')).toBe(true);
  });
});
