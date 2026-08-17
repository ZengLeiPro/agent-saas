import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebChannel } from '../channels/web/channel.js';
import type { AgentRunDispatch } from '../agent/types.js';
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

  it('durable replay with a cursor remains session-wide after that cursor', async () => {
    const channel = createChannel();
    const ws = new FakeWebSocket();
    const listPage = vi.fn(async () => ({ events: [], hasMore: false }));

    await (channel as any).replayDurableRuntimeEvents(
      {
        ws,
        user: { sub: 'admin-1', username: 'admin', role: 'admin' },
        alive: true,
        lastActivityAt: Date.now(),
      },
      'session-durable',
      { listPage },
      { lastEventId: 12, lastEventCursor: '1581', activeRunId: 'run-current' },
    );

    expect(listPage).toHaveBeenCalledWith('session-durable', {
      afterCursor: '1581',
      limit: 200,
    });
  });

  it('prewarms stream state before a durable cursor so a new ws-only process replays only the missing suffix', async () => {
    const channel = createChannel();
    const ws = new FakeWebSocket();
    const base = {
      timestamp: new Date().toISOString(),
      runId: 'run-cursor-stream',
      sessionId: 'session-cursor-stream',
    };
    const priorEvents = [
      { ...base, id: 'event-stream-start', sequence: '100', type: 'assistant_stream_event', blockType: 'text', phase: 'start' },
      { ...base, id: 'event-stream-delta', sequence: '101', type: 'assistant_stream_event', blockType: 'text', phase: 'delta', content: '游标前正文' },
      { ...base, id: 'event-stream-aggregate', sequence: '102', type: 'assistant_message', content: '游标前正文，补齐尾段', streamed: true },
      { ...base, id: 'event-stream-end', sequence: '103', type: 'assistant_stream_event', blockType: 'text', phase: 'end' },
    ];
    const store = {
      listByRun: vi.fn(async () => priorEvents),
      listPage: vi.fn(async () => ({ events: priorEvents.slice(2), hasMore: false })),
    };

    await (channel as any).replayDurableRuntimeEvents(
      {
        ws,
        user: { sub: 'admin-1', username: 'admin', role: 'admin' },
        alive: true,
        lastActivityAt: Date.now(),
      },
      'session-cursor-stream',
      store,
      { lastEventId: 9, lastEventCursor: '101', activeRunId: 'run-cursor-stream' },
    );

    expect(ws.sent).toEqual([
      {
        eventCursor: '102',
        data: { type: 'text', content: '，补齐尾段' },
      },
      {
        eventCursor: '103',
        data: { type: 'block_end', blockType: 'text' },
      },
    ]);
    expect(ws.sent.every((entry: any) => entry.eventId === undefined)).toBe(true);
  });

  it('recovers a terminal buffer event pushed while durable replay is awaiting and leaves no listener', async () => {
    let resolvePage!: (page: { events: never[]; hasMore: false }) => void;
    const listPage = vi.fn(() => new Promise<{ events: never[]; hasMore: false }>((resolve) => {
      resolvePage = resolve;
    }));
    const getActiveBySession = vi.fn().mockResolvedValue({
      runId: 'run-terminal-window',
      sessionId: 'session-terminal-window',
      userId: 'admin-1',
      status: 'running',
      metadata: { streamId: 'stream-terminal-window' },
    });
    const channel = new WebChannel({
      agentCwd: '/tmp/workspace',
      enqueueRuntime: { runStore: { getActiveBySession } } as any,
    }, noopDispatch);
    channels.push(channel);
    vi.spyOn(channel as any, 'getRuntimeEventStoreForSession').mockResolvedValue({ listPage });
    const ws = new FakeWebSocket();
    const client = {
      ws,
      user: { sub: 'admin-1', username: 'admin', role: 'admin' },
      alive: true,
      lastActivityAt: Date.now(),
    };

    const resume = (channel as any).handleResumeAsync(client, {
      action: 'resume',
      sessionId: 'session-terminal-window',
      lastEventId: 0,
      lastEventCursor: '499',
    });
    await vi.waitFor(() => expect(listPage).toHaveBeenCalledTimes(1));

    (channel as any).eventBufferStore.push(
      'session-terminal-window',
      JSON.stringify({ type: 'done', finalOutput: true }),
      '500',
    );
    (channel as any).eventBufferStore.complete('session-terminal-window');
    resolvePage({ events: [], hasMore: false });
    await resume;

    expect(ws.sent.filter((entry: any) => entry?.data?.type === 'done')).toEqual([
      { eventId: 1, eventCursor: '500', data: { type: 'done', finalOutput: true } },
    ]);
    const entry = (channel as any).eventBufferStore.get('session-terminal-window');
    expect(entry.listeners.size).toBe(0);
    expect(entry.completionListeners.size).toBe(0);
    expect((channel as any).resumeSubscriptions.has(ws)).toBe(false);
  });

  it('deduplicates a buffered replay-window event already covered by durable cursor', async () => {
    const channel = createChannel();
    const ws = new FakeWebSocket();
    const buffer = (channel as any).eventBufferStore;
    (channel as any).activeStreams.set('stream-cursor-window', {
      controller: new AbortController(),
      userId: 'admin-1',
      ws: new FakeWebSocket(),
      sessionId: 'session-cursor-window',
      runId: 'run-cursor-window',
    });
    buffer.create('session-cursor-window', 'admin-1');
    const durableTerminal = {
      id: 'terminal-500',
      sequence: '500',
      timestamp: new Date().toISOString(),
      type: 'run_state_changed',
      sessionId: 'session-cursor-window',
      runId: 'run-cursor-window',
      status: 'completed',
    };
    const listPage = vi.fn(async () => {
      buffer.push(
        'session-cursor-window',
        JSON.stringify({ type: 'done', sessionId: 'session-cursor-window', runId: 'run-cursor-window' }),
        '500',
      );
      buffer.complete('session-cursor-window');
      return { events: [durableTerminal], hasMore: false };
    });
    vi.spyOn(channel as any, 'getRuntimeEventStoreForSession').mockResolvedValue({ listPage });

    await (channel as any).handleResumeAsync(
      {
        ws,
        user: { sub: 'admin-1', username: 'admin', role: 'admin' },
        alive: true,
        lastActivityAt: Date.now(),
      },
      {
        action: 'resume',
        sessionId: 'session-cursor-window',
        lastEventId: 0,
        lastEventCursor: '499',
      },
    );

    expect(ws.sent.filter((entry: any) => entry?.data?.type === 'done')).toHaveLength(1);
    expect(buffer.get('session-cursor-window').listeners.size).toBe(0);
    expect((channel as any).resumeSubscriptions.has(ws)).toBe(false);
  });

  it('closes the ordinary buffer replay-to-subscribe window', async () => {
    const channel = createChannel();
    const ws = new FakeWebSocket();
    (channel as any).activeStreams.set('stream-buffer-window', {
      controller: new AbortController(),
      userId: 'admin-1',
      ws: new FakeWebSocket(),
      sessionId: 'session-buffer-window',
      runId: 'run-buffer-window',
    });
    const buffer = (channel as any).eventBufferStore;
    buffer.create('session-buffer-window', 'admin-1');
    buffer.push('session-buffer-window', JSON.stringify({ type: 'text', content: 'before disconnect' }));
    buffer.push('session-buffer-window', JSON.stringify({ type: 'text', content: 'first catchup' }));
    const originalSend = ws.send.bind(ws);
    let injected = false;
    vi.spyOn(ws, 'send').mockImplementation((raw: string) => {
      originalSend(raw);
      const sent = JSON.parse(raw);
      if (!injected && sent?.data?.content === 'first catchup') {
        injected = true;
        buffer.push('session-buffer-window', JSON.stringify({ type: 'done', finalOutput: true }));
        buffer.complete('session-buffer-window');
      }
    });

    await (channel as any).handleResumeAsync(
      {
        ws,
        user: { sub: 'admin-1', username: 'admin', role: 'admin' },
        alive: true,
        lastActivityAt: Date.now(),
      },
      { action: 'resume', sessionId: 'session-buffer-window', lastEventId: 1 },
    );

    expect(ws.sent.filter((entry: any) => entry?.data?.type === 'done')).toHaveLength(1);
    expect(buffer.get('session-buffer-window').listeners.size).toBe(0);
    expect((channel as any).resumeSubscriptions.has(ws)).toBe(false);
  });

  it('serializes concurrent resume on the same ws so only one buffer listener survives', async () => {
    // 前端重连时两个 onStateChange 监听器会在同一 tick 各对当前会话发一次 resume。
    // 若 handleResumeAsync 并发在 await 处交错，会残留两个 EventBuffer listener，
    // 每个流式事件被投递两次（前端逐字符重复）。串行化后同一 ws 只保留一个 listener。
    const getActiveBySession = vi.fn().mockResolvedValue({
      runId: 'run-race',
      sessionId: 'session-race',
      status: 'running',
      metadata: { streamId: 'stream-race' },
    });
    const channel = new WebChannel({
      agentCwd: '/tmp/workspace',
      enqueueRuntime: { runStore: { getActiveBySession } } as any,
    }, noopDispatch);
    channels.push(channel);
    const ws = new FakeWebSocket();

    (channel as any).activeStreams.set('stream-race', {
      controller: new AbortController(),
      userId: 'admin-1',
      ws: new FakeWebSocket(),
      sessionId: 'session-race',
      runId: 'run-race',
    });
    (channel as any).eventBufferStore.create('session-race', 'admin-1');

    const client = {
      ws,
      user: { sub: 'admin-1', username: 'admin', role: 'admin' },
      alive: true,
      lastActivityAt: Date.now(),
    };
    // 同一 tick 连发两条 resume（模拟重连双监听器）
    (channel as any).handleResume(client, { action: 'resume', sessionId: 'session-race', lastEventId: 0, skipReplay: true });
    (channel as any).handleResume(client, { action: 'resume', sessionId: 'session-race', lastEventId: 0, skipReplay: true });

    // 等 per-ws resume 串行链跑完
    await (channel as any).resumeChains.get(ws);

    // 一条 live 事件应只被投递一次（若泄漏了第二个 listener 会投递两次）
    ws.sent.length = 0;
    (channel as any).eventBufferStore.push('session-race', JSON.stringify({ type: 'text', content: 'live-token' }));

    const deliveries = ws.sent.filter(
      (m: any) => m?.data?.type === 'text' && m.data?.content === 'live-token',
    );
    expect(deliveries).toHaveLength(1);
  });
});
