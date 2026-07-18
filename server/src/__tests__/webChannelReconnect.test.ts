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

  const fakeEventBus = () => ({
    emitSession: () => {},
    emitUser: () => {},
    emitDual: () => {},
    emitReply: () => {},
  });

  it('expands streamed aggregates for cross-process runs (delta no longer persisted)', () => {
    const channel = createChannel();
    // publishRuntimePlatformEvent 在 eventBus 未初始化（未 start()）时提前 return
    (channel as any).eventBus = fakeEventBus();

    // 2026-07-03 起 assistant_stream_event 不落库：跨进程（非 inProcessOutboundRuns）
    // 的 streamed 聚合行必须整块展开，否则 ws-only 进程/replay 丢正文
    channel.publishRuntimePlatformEvent({
      id: 'evt-agg-1',
      timestamp: new Date().toISOString(),
      type: 'assistant_message',
      runId: 'run-cross-1',
      sessionId: 'session-agg-1',
      content: '跨进程正文',
      streamed: true,
    } as any);

    const buffer = (channel as any).eventBufferStore.get('session-agg-1');
    expect(buffer).toBeDefined();
    const datas = buffer.events.map((e: { data: string }) => JSON.parse(e.data));
    expect(datas).toEqual([
      { type: 'block_start', blockType: 'text' },
      { type: 'text', content: '跨进程正文' },
      { type: 'block_end', blockType: 'text' },
    ]);
  });

  it('still skips streamed aggregate content for in-process runs to avoid duplicates', () => {
    const channel = createChannel();
    (channel as any).eventBus = fakeEventBus();

    // 直推路径先把该 run 标记为同进程（live 内容已由 outbound deltas 送达）
    channel.publishRuntimeOutboundEvent({
      sessionId: 'session-agg-2',
      runId: 'run-inproc-1',
      event: { type: 'session_init', sessionId: 'session-agg-2' } as any,
    });

    // assistant_tool_calls 在同进程白名单内会到达翻译层：streamed 正文不得重复展开
    channel.publishRuntimePlatformEvent({
      id: 'evt-agg-2',
      timestamp: new Date().toISOString(),
      type: 'assistant_tool_calls',
      runId: 'run-inproc-1',
      sessionId: 'session-agg-2',
      content: '工具前说明',
      streamed: true,
      toolCalls: [{ id: 'call-1', name: 'Read', arguments: '{}' }],
    } as any);

    const buffer = (channel as any).eventBufferStore.get('session-agg-2');
    expect(buffer).toBeDefined();
    const datas = buffer.events.map((e: { data: string }) => JSON.parse(e.data));
    expect(datas.filter((d: { type: string }) => d.type === 'text')).toEqual([]);
    expect(datas.some((d: { blockType?: string }) => d.blockType === 'tool_use')).toBe(true);
  });

  it('projects Agent only through the dedicated subagent lifecycle', () => {
    const channel = createChannel();
    (channel as any).eventBus = fakeEventBus();
    const base = {
      timestamp: new Date().toISOString(),
      runId: 'run-agent-1',
      sessionId: 'session-agent-1',
    };

    channel.publishRuntimePlatformEvent({
      ...base,
      id: 'evt-agent-call',
      type: 'assistant_tool_calls',
      content: '',
      streamed: true,
      toolCalls: [{ id: 'call-agent-1', name: 'Agent', arguments: '{}' }],
    } as any);
    channel.publishRuntimePlatformEvent({
      ...base,
      id: 'evt-agent-invocation',
      type: 'tool_invocation_started',
      invocationId: 'inv-agent-1',
      toolCallId: 'call-agent-1',
      toolName: 'Agent',
      executionTarget: 'server-local',
    } as any);
    channel.publishRuntimePlatformEvent({
      ...base,
      id: 'evt-agent-started',
      type: 'subagent_started',
      toolCallId: 'call-agent-1',
      agentType: 'explore',
      description: '定位刷新状态',
      childSessionId: 'sub-1',
      childRunId: 'child-run-1',
      model: 'test/model',
    } as any);

    const buffer = (channel as any).eventBufferStore.get('session-agent-1');
    const datas = buffer.events.map((event: { data: string }) => JSON.parse(event.data));
    expect(datas).toEqual([{
      type: 'subagent_start',
      toolId: 'call-agent-1',
      agentType: '定位刷新状态',
      childSessionId: 'sub-1',
      childRunId: 'child-run-1',
      model: 'test/model',
    }]);
  });

  it('does not emit artifact_created after tool_result for in-process CreateArtifact deliveries', () => {
    const channel = createChannel();
    const emitted: any[] = [];
    (channel as any).eventBus = {
      ...fakeEventBus(),
      emitSession: (_ctx: unknown, data: unknown) => emitted.push(data),
    };

    channel.publishRuntimeOutboundEvent({
      sessionId: 'session-artifact-1',
      runId: 'run-artifact-1',
      event: {
        type: 'tool_result',
        toolId: 'call-artifact-1',
        toolName: 'CreateArtifact',
        toolResult: JSON.stringify({
          artifactId: 'artifact_test-1',
          kind: 'file',
          fileName: '客户清单.xlsx',
          sourcePath: 'assets/20260704/客户清单.xlsx',
          sizeBytes: 6454,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      } as any,
    });

    expect(emitted.some((d: { type: string }) => d.type === 'tool_result')).toBe(true);
    expect(emitted.some((d: { type: string }) => d.type === 'artifact_created')).toBe(false);
  });

  it('does not emit artifact_created for failed CreateArtifact (non-JSON tool error)', () => {
    const channel = createChannel();
    const emitted: any[] = [];
    (channel as any).eventBus = {
      ...fakeEventBus(),
      emitSession: (_ctx: unknown, data: unknown) => emitted.push(data),
    };

    channel.publishRuntimeOutboundEvent({
      sessionId: 'session-artifact-2',
      runId: 'run-artifact-2',
      event: {
        type: 'tool_result',
        toolId: 'call-artifact-2',
        toolName: 'CreateArtifact',
        toolResult: 'tool error: Current workspace runtime is still preparing.',
        isError: true,
      } as any,
    });

    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      toolId: 'call-artifact-2',
      isError: true,
    }));
    expect(emitted.some((d: { type: string }) => d.type === 'artifact_created')).toBe(false);
  });

  it('emits context_usage details when the tenant policy allows them', () => {
    const emitted: any[] = [];
    const channel = new WebChannel({
      agentCwd: '/tmp/workspace',
      userStore: {
        findById: vi.fn(() => ({
          id: 'user-allowed',
          username: 'member',
          role: 'user',
          tenantId: 'kaiyan',
        })),
      } as any,
      tenantStore: {
        getSettings: vi.fn(() => ({
          models: { showContextTokens: true, allowContextTokenDetails: true },
        })),
      } as any,
    }, noopDispatch);
    channels.push(channel);
    (channel as any).eventBus = {
      ...fakeEventBus(),
      emitSession: (_ctx: unknown, data: unknown) => emitted.push(data),
    };

    channel.publishRuntimeOutboundEvent({
      sessionId: 'session-context-1',
      runId: 'run-context-1',
      userId: 'user-allowed',
      event: {
        type: 'context_usage',
        contextUsage: {
          totalTokens: 1234,
          maxTokens: 10000,
          percentage: 0.1234,
          categories: [{ name: 'system', tokens: 100, color: '#000' }],
          memoryFiles: [{ path: 'MEMORY.md', type: 'long-term', tokens: 20 }],
          mcpTools: [{ name: 'Search', serverName: 'memory', tokens: 10 }],
        },
      } as any,
    });

    expect(emitted).toContainEqual({
      type: 'context_usage',
      contextUsage: {
        totalTokens: 1234,
        maxTokens: 10000,
        percentage: 0.1234,
        categories: [{ name: 'system', tokens: 100, color: '#000' }],
        memoryFiles: [{ path: 'MEMORY.md', type: 'long-term', tokens: 20 }],
        mcpTools: [{ name: 'Search', serverName: 'memory', tokens: 10 }],
      },
    });
  });

  it('redacts context_usage details when the tenant policy disables them', () => {
    const emitted: any[] = [];
    const channel = new WebChannel({
      agentCwd: '/tmp/workspace',
      userStore: {
        findById: vi.fn(() => ({
          id: 'user-1',
          username: 'user',
          role: 'user',
          tenantId: 'kaiyan',
        })),
      } as any,
      tenantStore: {
        getSettings: vi.fn(() => ({
          models: { showContextTokens: true, allowContextTokenDetails: false },
        })),
      } as any,
    }, noopDispatch);
    channels.push(channel);
    (channel as any).eventBus = {
      ...fakeEventBus(),
      emitSession: (_ctx: unknown, data: unknown) => emitted.push(data),
    };

    channel.publishRuntimeOutboundEvent({
      sessionId: 'session-context-2',
      runId: 'run-context-2',
      userId: 'user-1',
      event: {
        type: 'context_usage',
        contextUsage: {
          totalTokens: 4321,
          categories: [{ name: 'system', tokens: 100, color: '#000' }],
          memoryFiles: [{ path: 'MEMORY.md', type: 'long-term', tokens: 20 }],
          mcpTools: [{ name: 'Search', serverName: 'memory', tokens: 10 }],
        },
      } as any,
    });

    expect(emitted).toContainEqual({
      type: 'context_usage',
      contextUsage: {
        totalTokens: 4321,
        categories: [],
        memoryFiles: [],
        mcpTools: [],
      },
    });
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
