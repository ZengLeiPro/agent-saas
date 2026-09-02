import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  writeFileToolDescriptor,
  type AuthorizedToolCall,
  type ToolCallContext,
  type ToolDescriptor,
  type ToolResult,
  type ToolRuntime,
} from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import type { RunStore } from '../runtime/runStore.js';
import type { ModelAdapter, ModelEvent, ModelRequest, QueuedInterjection, RunContext } from '../runtime/types.js';
import type { OutboundEvent } from '../types/index.js';

class SerialToolsThenTextAdapter implements ModelAdapter {
  calls = 0;
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    this.requests.push(request);
    if (this.calls === 1) {
      yield {
        type: 'completed',
        content: '依次执行三个工具。',
        toolCalls: [1, 2, 3].map((index) => ({
          id: `call_serial_${index}`,
          name: 'SerialTest',
          arguments: JSON.stringify({ path: `result-${index}.txt`, content: String(index) }),
        })),
      };
      return;
    }
    yield { type: 'text_delta', content: '已优先处理补充消息。' };
    yield { type: 'completed', content: '已优先处理补充消息。', toolCalls: [] };
  }
}

class FinalTextAdapter implements ModelAdapter {
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const content = this.requests.length === 1 ? '第一段回答。' : '已按插话修正。';
    yield { type: 'text_delta', content };
    yield { type: 'completed', content, toolCalls: [] };
  }
}

class CompletionContinuationAdapter implements ModelAdapter {
  requests: ModelRequest[] = [];

  constructor(private readonly onSecondRequest: () => void) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 2) this.onSecondRequest();
    const content = `回答 ${this.requests.length}`;
    yield { type: 'completed', content, toolCalls: [] };
  }
}

class SerialCountingToolRuntime implements ToolRuntime {
  readonly invocations: string[] = [];
  private readonly descriptor: ToolDescriptor;

  constructor(
    private readonly onBoundaryInvocation: () => void,
    private readonly triggerAt = 1,
    parallel = false,
  ) {
    this.descriptor = {
      ...writeFileToolDescriptor,
      id: 'serial-test',
      name: 'SerialTest',
      displayName: '测试工具',
      risk: 'safe',
      approvalMode: 'never',
      ...(parallel ? { resolveConcurrency: () => 'parallel' as const } : {}),
    };
  }

  list(): ToolDescriptor[] {
    return [this.descriptor];
  }

  async invoke<TInput>(_call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult> {
    this.invocations.push(context.toolCallId!);
    if (this.invocations.length === this.triggerAt) this.onBoundaryInvocation();
    return { content: `executed ${context.toolCallId}` };
  }
}

async function collect(stream: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('RawAgentLoop user input boundaries', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  it('consumes pending user input in the same run after a final text turn exhausts maxTurns', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-final-text-interjection-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new FinalTextAdapter();
    let queued: QueuedInterjection[] = [{
      inputId: 'input-final-text', sourceRunId: 'source-final-text', clientMsgId: 'client-final-text',
      message: { channel: 'web', chatId: 'chat-final-text', content: '最后一刻补充' }, prompt: '最后一刻补充',
    }];
    let loadCalls = 0;
    const markApplied = vi.fn(async () => { queued = []; });
    const trySeal = vi.fn(async () => false);
    const loop = new RawAgentLoop({
      modelAdapter: adapter, eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-final-text', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new SerialCountingToolRuntime(() => undefined),
      runStore: {
        markSteeringInputsApplied: markApplied,
        trySealSteeringInputWindow: trySeal,
      } as unknown as RunStore,
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-final-text', content: '先回答' }, prompt: '先回答',
        instructions: '直接回答。', maxTurns: 1,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'target-final-text', sessionId: 'session-final-text', model: 'gpt-5.5', cwd,
        tenantId: DEFAULT_TENANT_ID, channelContext: { channel: 'web' },
        loadQueuedInterjections: async () => (++loadCalls === 1 ? [] : queued),
      },
    ));

    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]?.messages.slice(-2)).toEqual([
      { role: 'assistant', content: '第一段回答。' },
      { role: 'user', content: '最后一刻补充' },
    ]);
    expect(events.filter((event) => event.type === 'interjection_applied')).toEqual([{
      type: 'interjection_applied', sourceRunIds: ['source-final-text'], clientMsgIds: ['client-final-text'],
    }]);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(markApplied).toHaveBeenCalledWith('target-final-text', ['source-final-text']);
    expect(trySeal).toHaveBeenCalledWith('target-final-text');
  });

  it('leaves input arriving after a successful final seal for durable fallback', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-post-seal-fallback-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new FinalTextAdapter();
    let fallbackReady = false;
    const queued: QueuedInterjection[] = [{
      inputId: 'input-post-seal', sourceRunId: 'source-post-seal', clientMsgId: 'client-post-seal',
      message: { channel: 'web', chatId: 'chat-post-seal', content: '封口后补充' }, prompt: '封口后补充',
    }];
    const markApplied = vi.fn(async () => [] as string[]);
    const trySeal = vi.fn(async () => { fallbackReady = true; return true; });
    const loop = new RawAgentLoop({
      modelAdapter: adapter, eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-post-seal', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new SerialCountingToolRuntime(() => undefined),
      runStore: { markSteeringInputsApplied: markApplied, trySealSteeringInputWindow: trySeal } as unknown as RunStore,
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-post-seal', content: '先回答' }, prompt: '先回答',
        instructions: '直接回答。', maxTurns: 1,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'target-post-seal', sessionId: 'session-post-seal', model: 'gpt-5.5', cwd,
        tenantId: DEFAULT_TENANT_ID, channelContext: { channel: 'web' },
        loadQueuedInterjections: async () => fallbackReady ? queued : [],
      },
    ));

    expect(adapter.requests).toHaveLength(1);
    expect(events.some((event) => event.type === 'interjection_applied')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(markApplied).not.toHaveBeenCalled();
    expect(trySeal).toHaveBeenCalledWith('target-post-seal');
  });

  it('finishes the active serial tool, skips the rest, and extends the final turn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-interjection-between-tools-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new SerialToolsThenTextAdapter();
    let messageReady = false;
    let queued: QueuedInterjection[] = [{
      inputId: 'input-between-tools',
      sourceRunId: 'source-between-tools',
      clientMsgId: 'client-between-tools',
      message: { channel: 'web', chatId: 'chat-1', content: '停止后续步骤，先处理这个补充' },
      prompt: '[2026/09/02 周三 22:40] 停止后续步骤，先处理这个补充',
    }];
    const toolRuntime = new SerialCountingToolRuntime(() => { messageReady = true; });
    const markApplied = vi.fn(async () => { queued = []; });
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-between-tools', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime,
      runStore: {
        get: vi.fn(async () => ({
          runId: 'target-between-tools',
          sessionId: 'session-between-tools',
          status: 'running',
          requestedAt: '2026-09-02T14:40:00.000Z',
          updatedAt: '2026-09-02T14:40:00.000Z',
          metadata: {},
        })),
        markSteeringInputsApplied: markApplied,
        trySealSteeringInputWindow: vi.fn(async () => true),
      } as unknown as RunStore,
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '执行三个步骤' },
        prompt: '执行三个步骤',
        instructions: '按顺序执行。',
        maxTurns: 1,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'target-between-tools',
        sessionId: 'session-between-tools',
        model: 'gpt-5.5',
        cwd,
        tenantId: DEFAULT_TENANT_ID,
        channelContext: { channel: 'web' },
        loadQueuedInterjections: async () => messageReady ? queued : [],
      },
    ));

    expect(toolRuntime.invocations).toEqual(['call_serial_1']);
    expect(markApplied).toHaveBeenCalledWith('target-between-tools', ['source-between-tools']);
    expect(events.filter((event) => event.type === 'tool_result')).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolId: 'call_serial_2', toolResultMetadata: { skipped: true, reason: 'user_interjection' } }),
      expect.objectContaining({ toolId: 'call_serial_3', toolResultMetadata: { skipped: true, reason: 'user_interjection' } }),
    ]));
    const secondRequestMessages = adapter.requests[1]!.messages;
    expect(secondRequestMessages.slice(-4).map((message) => message.role)).toEqual(['tool', 'tool', 'tool', 'user']);
    expect(secondRequestMessages.at(-1)).toEqual({
      role: 'user',
      content: '[2026/09/02 周三 22:40] 停止后续步骤，先处理这个补充',
    });
  });

  it('rechecks after tool events and does not start a tool when user input arrives at that boundary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-interjection-before-invoke-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new SerialToolsThenTextAdapter();
    let messageReady = false;
    let queued: QueuedInterjection[] = [{
      inputId: 'input-before-invoke', sourceRunId: 'source-before-invoke', clientMsgId: 'client-before-invoke',
      message: { channel: 'web', chatId: 'chat-1', content: '不要启动工具' }, prompt: '不要启动工具',
    }];
    const toolRuntime = new SerialCountingToolRuntime(() => undefined);
    const loop = new RawAgentLoop({
      modelAdapter: adapter, eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-before-invoke', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')), toolRuntime,
      runStore: {
        get: vi.fn(async () => ({
          runId: 'target-before-invoke', sessionId: 'session-before-invoke', status: 'running',
          requestedAt: '2026-09-02T14:40:00.000Z', updatedAt: '2026-09-02T14:40:00.000Z', metadata: {},
        })),
        markSteeringInputsApplied: vi.fn(async () => { queued = []; }),
        trySealSteeringInputWindow: vi.fn(async () => true),
      } as unknown as RunStore,
    });
    const events: OutboundEvent[] = [];
    for await (const event of loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '执行三个步骤' }, prompt: '执行三个步骤',
        instructions: '按顺序执行。', maxTurns: 1,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'target-before-invoke', sessionId: 'session-before-invoke', model: 'gpt-5.5', cwd,
        tenantId: DEFAULT_TENANT_ID, channelContext: { channel: 'web' },
        loadQueuedInterjections: async () => messageReady ? queued : [],
      },
    )) {
      events.push(event);
      if (event.type === 'tool_end' && event.toolId === 'call_serial_1') messageReady = true;
    }

    expect(toolRuntime.invocations).toEqual([]);
    expect(events.filter((event) => event.type === 'tool_result')).toHaveLength(3);
    expect(adapter.requests).toHaveLength(2);
  });

  it.each([
    { name: 'checks after the final serial tool', triggerAt: 3, parallel: false },
    { name: 'waits for the full parallel group', triggerAt: 1, parallel: true },
  ])('$name and extends an exhausted turn budget', async ({ triggerAt, parallel }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-interjection-after-final-tool-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new SerialToolsThenTextAdapter();
    let messageReady = false;
    let queued: QueuedInterjection[] = [{
      inputId: 'input-after-final-tool',
      sourceRunId: 'source-after-final-tool',
      clientMsgId: 'client-after-final-tool',
      message: { channel: 'web', chatId: 'chat-1', content: '最后一个工具结束后处理我' },
      prompt: '[2026/09/02 周三 22:41] 最后一个工具结束后处理我',
    }];
    const toolRuntime = new SerialCountingToolRuntime(() => { messageReady = true; }, triggerAt, parallel);
    const markApplied = vi.fn(async () => { queued = []; });
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-final-tool', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime,
      runStore: {
        get: vi.fn(async () => ({
          runId: 'target-final-tool', sessionId: 'session-final-tool', status: 'running',
          requestedAt: '2026-09-02T14:40:00.000Z', updatedAt: '2026-09-02T14:40:00.000Z', metadata: {},
        })),
        markSteeringInputsApplied: markApplied,
        trySealSteeringInputWindow: vi.fn(async () => true),
      } as unknown as RunStore,
    });

    await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '执行三个步骤' },
        prompt: '执行三个步骤', instructions: '按顺序执行。', maxTurns: 1,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'target-final-tool', sessionId: 'session-final-tool', model: 'gpt-5.5', cwd,
        tenantId: DEFAULT_TENANT_ID, channelContext: { channel: 'web' },
        loadQueuedInterjections: async () => messageReady ? queued : [],
      },
    ));

    expect(toolRuntime.invocations).toEqual(['call_serial_1', 'call_serial_2', 'call_serial_3']);
    expect(markApplied).toHaveBeenCalledWith('target-final-tool', ['source-after-final-tool']);
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]!.messages.at(-1)).toEqual({
      role: 'user', content: '[2026/09/02 周三 22:41] 最后一个工具结束后处理我',
    });
  });
  it('keeps steering open while successful-completion requests another turn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-completion-continuation-interjection-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    let messageReady = false;
    let queued: QueuedInterjection[] = [{
      inputId: 'input-completion-continue', sourceRunId: 'source-completion-continue',
      message: { channel: 'web', chatId: 'chat-completion-continue', content: '续轮期间补充' },
      prompt: '续轮期间补充',
    }];
    const adapter = new CompletionContinuationAdapter(() => { messageReady = true; });
    const markApplied = vi.fn(async () => { queued = []; });
    const trySeal = vi.fn(async () => true);
    let completionChecks = 0;
    const loop = new RawAgentLoop({
      modelAdapter: adapter, eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-completion-continue', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      runStore: { markSteeringInputsApplied: markApplied, trySealSteeringInputWindow: trySeal } as unknown as RunStore,
    });

    const events = await collect(loop.run({
      message: { channel: 'web', chatId: 'chat-completion-continue', content: '完成任务' },
      prompt: '完成任务', instructions: '需要显式交接。', maxTurns: 1,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId: 'target-completion-continue', sessionId: 'session-completion-continue', model: 'gpt-5.5', cwd,
      tenantId: DEFAULT_TENANT_ID, channelContext: { channel: 'web' },
      loadQueuedInterjections: async () => messageReady ? queued : [],
      checkSuccessfulCompletion: async () => (++completionChecks === 1
        ? { action: 'continue', prompt: '仍需交接' }
        : { action: 'allow' }),
    }));

    expect(adapter.requests).toHaveLength(3);
    expect(adapter.requests[2]?.messages.at(-1)).toEqual({ role: 'user', content: '续轮期间补充' });
    expect(events.some((event) => event.type === 'interjection_applied')).toBe(true);
    expect(markApplied).toHaveBeenCalledWith('target-completion-continue', ['source-completion-continue']);
    expect(trySeal).toHaveBeenCalledTimes(1);
  });

  it('hands off instead of finishing when the final steering seal fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-seal-failure-handoff-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const drainHandoff = { requested: false } as NonNullable<RunContext['drainHandoff']>;
    const loop = new RawAgentLoop({
      modelAdapter: new FinalTextAdapter(), eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-seal-failure', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      runStore: {
        trySealSteeringInputWindow: vi.fn(async () => { throw new Error('seal unavailable'); }),
      } as unknown as RunStore,
    });

    const events = await collect(loop.run({
      message: { channel: 'web', chatId: 'chat-seal-failure', content: '先回答' }, prompt: '先回答',
      instructions: '直接回答。', maxTurns: 1,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId: 'target-seal-failure', sessionId: 'session-seal-failure', model: 'gpt-5.5', cwd,
      tenantId: DEFAULT_TENANT_ID, channelContext: { channel: 'web' }, drainHandoff,
    }));

    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(drainHandoff).toMatchObject({ requested: true, reason: 'steering_seal_failed' });
    const durable = await eventStore.list(DEFAULT_TENANT_ID, 'session-seal-failure');
    expect(durable.some((event) => event.type === 'run_finished')).toBe(false);
  });

});
