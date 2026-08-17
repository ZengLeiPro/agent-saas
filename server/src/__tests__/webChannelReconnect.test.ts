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
    // 客户端断线前已收到第 1 条（lastEventId=1），断线期间产生第 2 条。
    // 2026-08-04：resume 语义收敛为"补齐游标之后的增量"；无游标的全量重放
    // 已被禁止（见下方 no-cursor 用例），因此这里用真实增量场景断言。
    (channel as any).eventBufferStore.push('session-2', JSON.stringify({
      type: 'text',
      content: 'already delivered before disconnect',
    }));
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
      { action: 'resume', sessionId: 'session-2', requestId: 'resume-request-2', lastEventId: 1 },
    );

    expect(newWs.sent[0]).toEqual({
      data: {
        type: 'active_stream',
        sessionId: 'session-2',
        active: true,
        streamId: 'stream-2',
        status: 'running',
        requestId: 'resume-request-2',
      },
    });
    expect(newWs.sent[1]).toEqual({
      eventId: 2,
      data: { type: 'text', content: 'replayed' },
    });
    // 已投递过的那条不得重发
    expect(JSON.stringify(newWs.sent)).not.toContain('already delivered before disconnect');
    expect(onSpy).toHaveBeenCalledWith('close', expect.any(Function));
  });

  // 2026-08-04 P1 回归：刷新后重连的客户端只有 durable cursor、没有有效 buffer id。
  // buffer 的内存自增 id 与客户端错位时，getEventsAfter(sid, 0) 会把整个 buffer
  // 全量重放并叠加到 transcript 快照上（实证 fc3bf95a）。此场景必须改走
  // durable 增量重放（afterCursor），且不得重放 buffer 旧事件。
  it('resume with only a durable cursor replays durable increments instead of the full buffer', async () => {
    const channel = createChannel();
    const ws = new FakeWebSocket();

    (channel as any).activeStreams.set('stream-dc', {
      controller: new AbortController(),
      userId: 'admin-1',
      ws: new FakeWebSocket(),
      sessionId: 'session-dc',
      runId: 'run-dc',
    });
    (channel as any).eventBufferStore.create('session-dc', 'admin-1');
    (channel as any).eventBufferStore.push('session-dc', JSON.stringify({
      type: 'text',
      content: 'already shown in transcript snapshot',
    }));

    const listPage = vi.fn(async () => ({ events: [], hasMore: false }));
    vi.spyOn(channel as any, 'getRuntimeEventStoreForSession').mockResolvedValue({ listPage });

    (channel as any).handleResume(
      {
        ws,
        user: { sub: 'admin-1', username: 'admin', role: 'admin' },
        alive: true,
        lastActivityAt: Date.now(),
      },
      { action: 'resume', sessionId: 'session-dc', requestId: 'resume-request-durable', lastEventId: 0, lastEventCursor: '4321' },
    );
    await (channel as any).resumeChains.get(ws);

    expect(ws.sent[0]).toMatchObject({
      data: {
        type: 'active_stream', sessionId: 'session-dc', active: true,
        requestId: 'resume-request-durable',
      },
    });
    // durable 增量：从客户端 cursor 之后取，而不是 buffer 全量
    expect(listPage).toHaveBeenCalledWith('session-dc', {
      afterCursor: '4321',
      limit: 200,
    });
    expect(JSON.stringify(ws.sent)).not.toContain('already shown in transcript snapshot');
  });

  // 2026-08-04 P1 服务端兜底回归：客户端既无 buffer id 也无 durable cursor 时，
  // "重放"没有起点，全量重放必然与其 transcript 快照重叠。生产实测（会话
  // 7f4ff8d4）证明旧实现会把断线前已显示的文本再发一遍。
  it('skips replay entirely when the client has neither a buffer id nor a durable cursor', async () => {
    const channel = createChannel();
    const ws = new FakeWebSocket();

    (channel as any).activeStreams.set('stream-nc', {
      controller: new AbortController(),
      userId: 'admin-1',
      ws: new FakeWebSocket(),
      sessionId: 'session-nc',
      runId: 'run-nc',
    });
    (channel as any).eventBufferStore.create('session-nc', 'admin-1');
    (channel as any).eventBufferStore.push('session-nc', JSON.stringify({
      type: 'text',
      content: 'already rendered before the disconnect',
    }));

    const storeSpy = vi.spyOn(channel as any, 'getRuntimeEventStoreForSession');

    (channel as any).handleResume(
      {
        ws,
        user: { sub: 'admin-1', username: 'admin', role: 'admin' },
        alive: true,
        lastActivityAt: Date.now(),
      },
      { action: 'resume', sessionId: 'session-nc', lastEventId: 0, lastEventCursor: null, skipReplay: false },
    );
    await (channel as any).resumeChains.get(ws);

    // 仍要告知客户端流是活的（客户端据此刷新 transcript 并继续跟随）
    expect(ws.sent[0]).toMatchObject({
      data: { type: 'active_stream', sessionId: 'session-nc', active: true },
    });
    // 但绝不重放任何历史内容
    expect(JSON.stringify(ws.sent)).not.toContain('already rendered before the disconnect');
    expect(storeSpy).not.toHaveBeenCalled();
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

  it('expands streamed aggregates for cross-process runs without stream batches', () => {
    const channel = createChannel();
    // publishRuntimePlatformEvent 在 eventBus 未初始化（未 start()）时提前 return
    (channel as any).eventBus = fakeEventBus();

    // 兼容没有 assistant_stream_event 的旧 run：跨进程（非 inProcessOutboundRuns）
    // 的 streamed 聚合行仍必须整块展开，否则 ws-only 进程/replay 丢正文
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
      { type: 'block_start', blockType: 'text', runId: 'run-cross-1' },
      { type: 'text', content: '跨进程正文' },
      { type: 'block_end', blockType: 'text' },
    ]);
  });

  it('attaches an assistant PlatformEvent cursor only to its final live WS frame', () => {
    const channel = createChannel();
    (channel as any).eventBus = fakeEventBus();
    const ws = new FakeWebSocket();
    (channel as any).activeStreams.set('stream-cursor-live', {
      controller: new AbortController(),
      userId: 'admin-1',
      ws,
      sessionId: 'session-cursor-live',
      runId: 'run-cursor-live',
    });
    (channel as any).wsActiveStream.set(ws, 'stream-cursor-live');

    channel.publishRuntimePlatformEvent({
      id: 'evt-cursor-live',
      sequence: 701,
      timestamp: new Date().toISOString(),
      type: 'assistant_message',
      runId: 'run-cursor-live',
      sessionId: 'session-cursor-live',
      content: '跨进程正文',
      streamed: true,
    } as any);

    expect(ws.sent).toEqual([
      {
        eventId: 1,
        data: { type: 'block_start', blockType: 'text', runId: 'run-cursor-live' },
      },
      { eventId: 2, data: { type: 'text', content: '跨进程正文' } },
      {
        eventId: 3,
        eventCursor: '701',
        data: { type: 'block_end', blockType: 'text' },
      },
    ]);
  });

  it('projects persisted stream batches before the terminal aggregate without duplicating text', () => {
    const channel = createChannel();
    (channel as any).eventBus = fakeEventBus();
    const base = {
      timestamp: new Date().toISOString(),
      runId: 'run-cross-stream-1',
      sessionId: 'session-cross-stream-1',
    };

    for (const event of [
      { ...base, id: 'evt-stream-start', type: 'assistant_stream_event', blockType: 'text', phase: 'start', draftId: 'draft-1' },
      { ...base, id: 'evt-stream-delta-1', type: 'assistant_stream_event', blockType: 'text', phase: 'delta', content: '跨进程' },
      { ...base, id: 'evt-stream-delta-2', type: 'assistant_stream_event', blockType: 'text', phase: 'delta', content: '流式正文' },
      { ...base, id: 'evt-stream-aggregate', type: 'assistant_message', content: '跨进程流式正文', streamed: true },
      { ...base, id: 'evt-stream-end', type: 'assistant_stream_event', blockType: 'text', phase: 'end' },
      { ...base, id: 'evt-stream-commit', type: 'assistant_stream_event', phase: 'commit', draftId: 'draft-1' },
    ]) {
      channel.publishRuntimePlatformEvent(event as any);
    }

    const buffer = (channel as any).eventBufferStore.get('session-cross-stream-1');
    expect(buffer).toBeDefined();
    const datas = buffer.events.map((e: { data: string }) => JSON.parse(e.data));
    expect(datas).toEqual([
      { type: 'block_start', blockType: 'text', draftId: 'draft-1' },
      { type: 'text', content: '跨进程' },
      { type: 'text', content: '流式正文' },
      { type: 'block_end', blockType: 'text' },
      { type: 'draft_commit', draftId: 'draft-1' },
    ]);
  });

  it('fills a missing relay tail from the durable aggregate before closing the block', () => {
    const channel = createChannel();
    (channel as any).eventBus = fakeEventBus();
    const base = {
      timestamp: new Date().toISOString(),
      runId: 'run-cross-tail-1',
      sessionId: 'session-cross-tail-1',
    };

    for (const event of [
      { ...base, id: 'evt-tail-start', type: 'assistant_stream_event', blockType: 'text', phase: 'start' },
      { ...base, id: 'evt-tail-delta', type: 'assistant_stream_event', blockType: 'text', phase: 'delta', content: '已实时送达' },
      { ...base, id: 'evt-tail-aggregate', type: 'assistant_message', content: '已实时送达，终态补齐', streamed: true },
      // RawAgentLoop 先 append 聚合行、再 yield text_end；relay 的最后一批可能晚于聚合行。
      { ...base, id: 'evt-tail-late-delta', type: 'assistant_stream_event', blockType: 'text', phase: 'delta', content: '，终态补齐' },
      { ...base, id: 'evt-tail-end', type: 'assistant_stream_event', blockType: 'text', phase: 'end' },
    ]) {
      channel.publishRuntimePlatformEvent(event as any);
    }

    const buffer = (channel as any).eventBufferStore.get('session-cross-tail-1');
    const datas = buffer.events.map((e: { data: string }) => JSON.parse(e.data));
    expect(datas).toEqual([
      { type: 'block_start', blockType: 'text' },
      { type: 'text', content: '已实时送达' },
      { type: 'text', content: '，终态补齐' },
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

  it('projects replaceable draft outbound events into the WebSocket protocol', () => {
    const channel = createChannel();
    const emitted: any[] = [];
    (channel as any).eventBus = {
      ...fakeEventBus(),
      emitSession: (_ctx: unknown, data: unknown) => emitted.push(data),
    };

    for (const event of [
      { type: 'text_start', draftId: 'draft-1' },
      { type: 'draft_reset', draftId: 'draft-1', attempt: 2 },
      { type: 'draft_commit', draftId: 'draft-1' },
    ] as const) {
      channel.publishRuntimeOutboundEvent({
        sessionId: 'session-draft-1',
        runId: 'run-draft-1',
        event,
      });
    }

    expect(emitted).toEqual([
      { type: 'block_start', blockType: 'text', runId: 'run-draft-1', draftId: 'draft-1' },
      { type: 'draft_reset', draftId: 'draft-1', attempt: 2 },
      { type: 'draft_commit', draftId: 'draft-1' },
    ]);
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
        breakdown: undefined,
        usageTotals: undefined,
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
      { action: 'resume', sessionId: 'session-ghost-2', requestId: 'resume-request-inactive', lastEventId: 0, skipReplay: true },
    );

    expect(getActiveBySession).toHaveBeenCalledWith('session-ghost-2');
    // 必须回 inactive，且幽灵 buffer 被收口
    expect(ws.sent).toContainEqual({
      data: {
        type: 'active_stream', sessionId: 'session-ghost-2', active: false,
        requestId: 'resume-request-inactive',
      },
    });
    expect((channel as any).eventBufferStore.isActive('session-ghost-2')).toBe(false);
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
        user: { sub: 'admin-1', username: 'admin', role: 'admin' },
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

    expect(ws.sent[0]).toEqual({
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

  it('durable replay without a cursor is limited to the active run', async () => {
    const channel = createChannel();
    const ws = new FakeWebSocket();
    const events = [
      {
        id: 'event-old-answer',
        timestamp: new Date().toISOString(),
        type: 'assistant_message',
        sessionId: 'session-durable',
        runId: 'run-old',
        content: '不应再次出现的历史回答',
        streamed: true,
      },
      {
        id: 'event-current-answer',
        timestamp: new Date().toISOString(),
        type: 'assistant_message',
        sessionId: 'session-durable',
        runId: 'run-current',
        content: '当前轮回答',
        streamed: true,
      },
    ];
    const listPage = vi.fn(async (_sessionId: string, options: { runId?: string }) => ({
      events: options.runId ? events.filter((event) => event.runId === options.runId) : events,
      hasMore: false,
    }));

    await (channel as any).replayDurableRuntimeEvents(
      {
        ws,
        user: { sub: 'admin-1', username: 'admin', role: 'admin' },
        alive: true,
        lastActivityAt: Date.now(),
      },
      'session-durable',
      { listPage },
      { lastEventId: 0, activeRunId: 'run-current' },
    );

    expect(listPage).toHaveBeenCalledWith('session-durable', {
      afterCursor: undefined,
      limit: 200,
      runId: 'run-current',
    });
    expect(JSON.stringify(ws.sent)).toContain('当前轮回答');
    expect(JSON.stringify(ws.sent)).not.toContain('不应再次出现的历史回答');
  });

});
