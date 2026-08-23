import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformToolRuntime } from '../agent/toolRuntime.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { buildContextProjection } from '../runtime/contextProjection.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import type { LatestResponseSessionState, RunStore } from '../runtime/runStore.js';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  QueuedInterjection,
  RunContext,
} from '../runtime/types.js';
import type { OutboundEvent } from '../types/index.js';

async function collect(stream: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('RawAgentLoop.compact（/compact 真实现）', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  class SummaryAdapter implements ModelAdapter {
    requests: ModelRequest[] = [];
    constructor(private readonly summaryChunks: string[]) {}

    async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
      this.requests.push(request);
      for (const chunk of this.summaryChunks) {
        yield { type: 'text_delta', content: chunk };
      }
      yield {
        type: 'completed',
        content: this.summaryChunks.join(''),
        toolCalls: [],
        usage: { inputTokens: 500, outputTokens: 60 },
      };
    }
  }

  async function makeCompactHarness(
    adapter: ModelAdapter,
    options: { relayState?: LatestResponseSessionState | null; compactionPrompt?: string } = {},
  ) {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-compact-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
    const clearedSessions: string[] = [];
    const runStore = {
      upsertPending: vi.fn(),
      markStatus: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      listRecoverable: vi.fn().mockResolvedValue([]),
      findLatestResponseSessionStateBySession: vi.fn().mockResolvedValue(options.relayState ?? null),
      clearResponseSessionStateBySession: vi.fn(async (sessionId: string) => {
        clearedSessions.push(sessionId);
        return 2;
      }),
    } as unknown as RunStore;
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-compact'),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore,
      compactionPrompt: options.compactionPrompt,
    });
    const context: RunContext = {
      runId: 'run-compact-1',
      sessionId: 'session-compact',
      model: 'glm-5.2',
      cwd,
      channelContext: {
        channel: 'web',
        user: { id: 'user-1', username: 'leo', role: 'user' },
      },
    };
    return { cwd, eventStore, loop, context, clearedSessions };
  }

  /** 4 轮真实交互：统一 checkpoint planner 根据 Token 预算选择原始尾部，不再固定保留 1 轮。 */
  async function seedHistory(eventStore: FileEventStore) {
    await eventStore.append({ type: 'user_message', runId: 'run-old-1', sessionId: 'session-compact', content: '帮我分析 A 方案' });
    await eventStore.append({ type: 'assistant_message', runId: 'run-old-1', sessionId: 'session-compact', content: 'A 方案的结论是 X=42。' });
    await eventStore.append({ type: 'user_message', runId: 'run-old-2', sessionId: 'session-compact', content: '再对比 B 方案' });
    await eventStore.append({ type: 'assistant_message', runId: 'run-old-2', sessionId: 'session-compact', content: 'B 方案成本更低，推荐 B。' });
    await eventStore.append({ type: 'user_message', runId: 'run-old-3', sessionId: 'session-compact', content: '那 C 方案呢' });
    await eventStore.append({ type: 'assistant_message', runId: 'run-old-3', sessionId: 'session-compact', content: 'C 方案不可行。' });
    await eventStore.append({ type: 'user_message', runId: 'run-old-4', sessionId: 'session-compact', content: '最后看下 D 方案' });
    await eventStore.append({ type: 'assistant_message', runId: 'run-old-4', sessionId: 'session-compact', content: 'D 方案与 B 接近，仍推荐 B。' });
  }

  it('成功链路：黑箱事件流、cutoff 落库、接力链清空、投影=摘要+轨迹+保留窗口', async () => {
    const adapter = new SummaryAdapter(['## 摘要\n', '用户对比了 A/B 方案，结论：推荐 B（成本更低），A 的结论是 X=42。']);
    const { eventStore, loop, context, clearedSessions } = await makeCompactHarness(adapter);
    await seedHistory(eventStore);

    const outbound = await collect(loop.compact(
      { message: { channel: 'web', chatId: 'chat-1', content: '/compact' }, instructions: '你是开开，会话正常指令。' },
      context,
    ));

    // 出站流是黑箱：只有 compaction_start / compaction_end / done，无 thinking/text 流
    expect(outbound[0]).toEqual({ type: 'compaction_start' });
    expect(outbound.at(-1)).toEqual({ type: 'done' });
    expect(outbound.some((e) => e.type === 'text_delta' || e.type === 'thinking_delta')).toBe(false);
    const end = outbound.find((e) => e.type === 'compaction_end') as any;
    expect(end.compaction.summary).toContain('推荐 B');
    expect(end.compaction.coveredEventCount).toBe(8); // 测试模型未配置窗口，保守压缩完整前缀
    expect(end.compaction.skipped).toBeUndefined();

    // 摘要请求保持缓存前缀友好：原 system + 待摘要历史 + 末尾压缩请求 user；
    // 工具定义照常带上但 toolChoice='none'；无接力状态时不带 previousResponseId
    expect(adapter.requests).toHaveLength(1);
    const request = adapter.requests[0]!;
    expect(request.messages[0]).toEqual({ role: 'system', content: '你是开开，会话正常指令。' });
    expect(request.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('上下文压缩') });
    expect(request.messages.at(-1)?.content).toContain('最近完整执行尾部');
    const requestContents = request.messages.map((m) => m.content);
    expect(requestContents).toContain('帮我分析 A 方案');
    expect(requestContents).toContain('再对比 B 方案');
    expect(requestContents).toContain('那 C 方案呢');
    expect(requestContents).toContain('最后看下 D 方案');
    expect(requestContents).toContain('D 方案与 B 接近，仍推荐 B。');
    expect(request.tools.length).toBeGreaterThan(0);
    expect(request.toolChoice).toBe('none');
    expect(request.previousResponseId).toBeUndefined();

    // 事件落库：run_started → user_message(替身) → compaction_usage → compaction → run_finished；
    // v2 起摘要不再落 assistant_message，usage 仍需独立进入 Billing 投影。
    const events = await eventStore.list('session-compact');
    const compactRunEvents = events.filter((e) => 'runId' in e && e.runId === 'run-compact-1');
    expect(compactRunEvents.map((e) => e.type)).toEqual([
      'run_started', 'user_message', 'compaction_usage', 'compaction', 'run_finished',
    ]);
    expect(events.find((e) => e.type === 'compaction_usage')).toMatchObject({
      model: 'glm-5.2',
      usage: { inputTokens: 500, outputTokens: 60 },
    });

    const compaction = events.find((e) => e.type === 'compaction') as any;
    expect(compaction.summary).toContain('推荐 B');
    expect(compaction.coveredEventCount).toBe(8);
    expect(compaction.cutoffEventId).toBeUndefined();
    expect(compaction.checkpoint).toMatchObject({
      version: 1,
      trigger: 'manual',
      taskAnchors: [],
      summaryAudit: {
        model: 'glm-5.2',
        promptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        validation: {
          schemaVersion: 1,
          valid: false,
          maintenanceInstructionAttributedToUser: false,
        },
        userHistoryTokenCap: expect.any(Number),
      },
    });

    const userMessage = events.find((e) => e.type === 'user_message' && e.runId === 'run-compact-1') as any;
    expect(userMessage.content).toBe('/compact');
    expect(userMessage.modelContent).toContain('[系统命令]');

    const runFinished = events.find((e) => e.type === 'run_finished' && (e as any).runId === 'run-compact-1') as any;
    expect(runFinished.subtype).toBe('success');
    expect(runFinished.modelUsage?.['glm-5.2']).toMatchObject({ inputTokens: 500, outputTokens: 60 });

    // 接力链已按 session 清空
    expect(clearedSessions).toEqual(['session-compact']);

    // 闭环：下一个 run 的投影 = checkpoint summary + 全量用户轨迹；compact run 自身事件不出现
    const projection = buildContextProjection(await eventStore.list('session-compact'), {
      sessionId: 'session-compact',
      runId: 'run-next',
    });
    expect(projection.messages).toHaveLength(1);
    const summary = projection.messages[0]!;
    expect(summary).toMatchObject({ role: 'user' });
    expect(summary.content).toContain('<context-summary>');
    expect(summary.content).toContain('推荐 B');
    // 轨迹：逐条列出被压缩段的全部真实用户消息，不静默省略。
    expect(summary.content).toContain('<user-message-trail>');
    expect(summary.content).toContain('帮我分析 A 方案');
    expect(summary.content).toContain('再对比 B 方案');
    expect(summary.content).toContain('那 C 方案呢');
    expect(summary.content).toContain('最后看下 D 方案');
    expect(summary.content).toContain('SessionContext');
    expect(projection.messages.some((m) => typeof m.content === 'string' && m.content.includes('/compact'))).toBe(false);
  });

  it('手动 /compact 使用平台配置的压缩指令', async () => {
    const adapter = new SummaryAdapter(['自定义指令摘要。']);
    const { eventStore, loop, context } = await makeCompactHarness(adapter, {
      compactionPrompt: '请按自定义格式输出压缩摘要。',
    });
    await seedHistory(eventStore);

    await collect(loop.compact(
      { message: { channel: 'web', chatId: 'chat-1', content: '/compact' }, instructions: '正常指令' },
      context,
    ));

    expect(adapter.requests[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: '请按自定义格式输出压缩摘要。',
    });
  });

  it('Responses 接力状态存在时仍用本地全量投影压缩，避免已超窗远端链接力失败', async () => {
    const adapter = new SummaryAdapter(['接力摘要正文，长度足够作为摘要输出。']);
    const { eventStore, loop, context, clearedSessions } = await makeCompactHarness(adapter, {
      relayState: { runId: 'run-prev', lastResponseId: 'resp_prev_123', lastResponseModel: 'glm-5.2' },
    });
    await seedHistory(eventStore);

    const outbound = await collect(loop.compact(
      { message: { channel: 'web', chatId: 'chat-1', content: '/compact' }, instructions: '正常指令' },
      context,
    ));

    expect(outbound.at(-1)).toEqual({ type: 'done' });
    expect(adapter.requests[0]?.previousResponseId).toBeUndefined();
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('帮我分析 A 方案');
    // 压缩完成后接力链必须被清空，下一轮全量重建（带 summary）
    expect(clearedSessions).toEqual(['session-compact']);
  });

  it('历史太短（空会话）：compaction_end 带 skipped，不产生 compaction 事件', async () => {
    const adapter = new SummaryAdapter(['不应被调用']);
    const { eventStore, loop, context } = await makeCompactHarness(adapter);

    const outbound = await collect(loop.compact(
      { message: { channel: 'web', chatId: 'chat-1', content: '/compact' }, instructions: '正常指令' },
      context,
    ));

    expect(adapter.requests).toHaveLength(0);
    expect(outbound[0]).toEqual({ type: 'compaction_start' });
    expect(outbound.at(-1)).toEqual({ type: 'done' });
    const end = outbound.find((e) => e.type === 'compaction_end') as any;
    expect(end.compaction.skipped).toBe(true);
    expect(end.compaction.note).toContain('无需压缩');
    const events = await eventStore.list('session-compact');
    expect(events.some((e) => e.type === 'compaction')).toBe(false);
    expect((events.find((e) => e.type === 'run_finished') as any)?.subtype).toBe('success');
  });

  it('仅 2 轮真实交互也使用统一 planner 建立 checkpoint', async () => {
    const adapter = new SummaryAdapter(['两轮历史摘要。']);
    const { eventStore, loop, context } = await makeCompactHarness(adapter);
    await eventStore.append({ type: 'user_message', runId: 'run-old-1', sessionId: 'session-compact', content: '帮我分析 A 方案' });
    await eventStore.append({ type: 'assistant_message', runId: 'run-old-1', sessionId: 'session-compact', content: 'A 方案的结论是 X=42。' });
    await eventStore.append({ type: 'user_message', runId: 'run-old-2', sessionId: 'session-compact', content: '再对比 B 方案' });
    await eventStore.append({ type: 'assistant_message', runId: 'run-old-2', sessionId: 'session-compact', content: 'B 方案成本更低，推荐 B。' });

    const outbound = await collect(loop.compact(
      { message: { channel: 'web', chatId: 'chat-1', content: '/compact' }, instructions: '正常指令' },
      context,
    ));

    expect(adapter.requests).toHaveLength(1);
    const end = outbound.find((e) => e.type === 'compaction_end') as any;
    expect(end.compaction.skipped).toBeUndefined();
    const checkpoint = (await eventStore.list('session-compact')).find((e) => e.type === 'compaction') as any;
    expect(checkpoint.checkpoint).toMatchObject({ version: 1, trigger: 'manual' });
  });

  it('模型返回空摘要：run_finished error，无 compaction，防御性 modelContent 保证投影无裸 /compact', async () => {
    class EmptyAdapter implements ModelAdapter {
      async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
        yield { type: 'completed', content: '', toolCalls: [] };
      }
    }
    const { eventStore, loop, context, clearedSessions } = await makeCompactHarness(new EmptyAdapter());
    await seedHistory(eventStore);

    const outbound = await collect(loop.compact(
      { message: { channel: 'web', chatId: 'chat-1', content: '/compact' }, instructions: '正常指令' },
      context,
    ));

    expect(outbound.at(-1)).toMatchObject({ type: 'error' });
    expect((outbound.at(-1) as any).error).toContain('压缩失败');
    const events = await eventStore.list('session-compact');
    expect(events.some((e) => e.type === 'compaction')).toBe(false);
    expect((events.find((e) => e.type === 'run_finished') as any)?.subtype).toBe('error');
    expect(clearedSessions).toEqual([]); // 失败时不清接力链

    // 残留的 /compact user_message 投影后是防御说明文本，不是裸命令
    const projection = buildContextProjection(events, { sessionId: 'session-compact', runId: 'run-next' });
    const lastUser = projection.messages.filter((m) => m.role === 'user').at(-1);
    expect(lastUser?.content).toContain('[系统命令]');
    expect(lastUser?.content).not.toBe('/compact');
  });

  it('自动压缩作为同一 run 尾阶段执行，压缩期间到达的用户消息以插话继续 loop', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-inline-auto-compact-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
    for (let i = 1; i <= 3; i++) {
      await eventStore.append({
        type: 'user_message',
        runId: `run-old-${i}`,
        sessionId: 'session-inline-auto',
        content: `历史问题 ${i}`,
      });
      await eventStore.append({
        type: 'assistant_message',
        runId: `run-old-${i}`,
        sessionId: 'session-inline-auto',
        content: `历史回答 ${i}`,
      });
    }

    const compactionPrompt = '请按自定义自动压缩格式输出摘要。';
    let queued: QueuedInterjection[] = [];
    class InlineAutoCompactAdapter implements ModelAdapter {
      requests: ModelRequest[] = [];
      normalCalls = 0;

      async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
        this.requests.push(request);
        const lastContent = request.messages.at(-1)?.content;
        const isCompaction = lastContent === compactionPrompt;
        if (isCompaction) {
          queued = [{
            inputId: 'input-during-compact',
            sourceRunId: 'source-during-compact',
            clientMsgId: 'client-during-compact',
            message: { channel: 'web', chatId: 'chat-inline-auto', content: '压缩期间的新消息' },
            prompt: '压缩期间的新消息',
          }];
          yield { type: 'text_delta', content: '## 自动摘要\n较早三轮历史已归纳。' };
          yield {
            type: 'completed',
            content: '## 自动摘要\n较早三轮历史已归纳。',
            toolCalls: [],
            usage: { inputTokens: 300, outputTokens: 30 },
          };
          return;
        }
        this.normalCalls += 1;
        const content = this.normalCalls === 1 ? '上一条任务已经完成。' : '已接着处理压缩期间的新消息。';
        yield { type: 'text_delta', content };
        yield {
          type: 'completed',
          content,
          toolCalls: [],
          usage: { inputTokens: 100, outputTokens: 10 },
        };
      }
    }

    const adapter = new InlineAutoCompactAdapter();
    const patchMetadata = vi.fn(async () => null);
    const markApplied = vi.fn(async (_targetRunId: string, sourceRunIds: string[]) => {
      queued = [];
      return sourceRunIds;
    });
    const runStore = {
      get: vi.fn(async () => ({
        status: 'running',
        metadata: {
          contextPressure: {
            reason: 'context_governor',
            detectedAt: '2026-08-03T02:00:00.000Z',
            triggerTokens: 230_000,
            thresholdTokens: 217_600,
            droppedMessages: 427,
          },
        },
      })),
      patchMetadata,
      markSteeringInputsApplied: markApplied,
      trySealSteeringInputWindow: vi.fn(async () => true),
      clearResponseSessionStateBySession: vi.fn(async () => 1),
      findLatestResponseSessionStateBySession: vi.fn(async () => null),
    } as unknown as RunStore;
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-inline-auto'),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore,
      compactionPrompt,
    });
    let evaluations = 0;
    const forceReasons: Array<string | undefined> = [];
    const outbound = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-inline-auto', content: '完成当前任务' },
        prompt: '完成当前任务',
        instructions: '正常系统指令',
        maxTurns: 1,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-inline-auto',
        sessionId: 'session-inline-auto',
        model: 'glm-5.2',
        cwd,
        channelContext: { channel: 'web' },
        loadQueuedInterjections: async () => queued,
        evaluateAutoCompaction: (_events, forceReason) => {
          forceReasons.push(forceReason);
          return {
            shouldCompact: evaluations++ === 0,
            reason: forceReason ?? 'below_threshold',
          };
        },
      },
    ));

    expect(adapter.normalCalls).toBe(2);
    expect(adapter.requests).toHaveLength(3);
    expect(adapter.requests[1]?.messages.at(-1)).toEqual({ role: 'user', content: compactionPrompt });
    expect(JSON.stringify(adapter.requests[2]?.messages)).toContain('## 自动摘要');
    expect(JSON.stringify(adapter.requests[2]?.messages)).toContain('完成当前任务');
    expect(JSON.stringify(adapter.requests[2]?.messages)).toContain('<resume-policy>');
    expect(JSON.stringify(adapter.requests[2]?.messages)).toContain('压缩期间的新消息');
    expect(markApplied).toHaveBeenCalledWith('run-inline-auto', ['source-during-compact']);
    expect(forceReasons).toEqual(['context_governor', undefined]);
    expect(patchMetadata).toHaveBeenCalledWith('run-inline-auto', expect.objectContaining({
      contextPressure: null,
      autoCompactedAt: expect.any(String),
    }));
    expect(outbound.map((event) => event.type)).toContain('compaction_start');
    expect(outbound.map((event) => event.type)).toContain('compaction_end');
    expect(outbound.at(-1)).toEqual({ type: 'done' });

    const events = await eventStore.list('session-inline-auto');
    expect(events.filter((event) => event.type === 'run_started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'run_finished')).toHaveLength(1);
    const compactionIndex = events.findIndex((event) => event.type === 'compaction');
    const interjectionIndex = events.findIndex((event) => (
      event.type === 'user_message' && event.interjectionSourceRunId === 'source-during-compact'
    ));
    expect(compactionIndex).toBeGreaterThan(0);
    expect(interjectionIndex).toBeGreaterThan(compactionIndex);
    expect(events[compactionIndex]).toMatchObject({
      type: 'compaction',
      runId: 'run-inline-auto',
      inline: true,
    });
  });

  it('内联自动压缩失败时不终止 run，压缩期间的插话仍继续处理', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-inline-auto-compact-failure-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
    for (let i = 1; i <= 3; i++) {
      await eventStore.append({
        type: 'user_message',
        runId: `run-old-${i}`,
        sessionId: 'session-inline-auto-failure',
        content: `历史问题 ${i}`,
      });
      await eventStore.append({
        type: 'assistant_message',
        runId: `run-old-${i}`,
        sessionId: 'session-inline-auto-failure',
        content: `历史回答 ${i}`,
      });
    }

    let queued: QueuedInterjection[] = [];
    class FailedInlineCompactionAdapter implements ModelAdapter {
      requests: ModelRequest[] = [];
      normalCalls = 0;

      async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
        this.requests.push(request);
        const lastContent = request.messages.at(-1)?.content;
        const isCompaction = typeof lastContent === 'string' && lastContent.includes('上下文压缩');
        if (isCompaction) {
          queued = [{
            inputId: 'input-during-failed-compact',
            sourceRunId: 'source-during-failed-compact',
            clientMsgId: 'client-during-failed-compact',
            message: { channel: 'web', chatId: 'chat-inline-auto-failure', content: '压缩失败时的新消息' },
            prompt: '压缩失败时的新消息',
          }];
          yield { type: 'completed', content: '', toolCalls: [] };
          return;
        }
        this.normalCalls += 1;
        const content = this.normalCalls === 1 ? '当前任务已完成。' : '压缩失败了，但新消息已继续处理。';
        yield { type: 'completed', content, toolCalls: [] };
      }
    }

    const adapter = new FailedInlineCompactionAdapter();
    const markApplied = vi.fn(async (_targetRunId: string, sourceRunIds: string[]) => {
      queued = [];
      return sourceRunIds;
    });
    const runStore = {
      markSteeringInputsApplied: markApplied,
      trySealSteeringInputWindow: vi.fn(async () => true),
      clearResponseSessionStateBySession: vi.fn(async () => 0),
      findLatestResponseSessionStateBySession: vi.fn(async () => null),
    } as unknown as RunStore;
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-inline-auto-failure'),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore,
    });
    let evaluations = 0;
    const outbound = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-inline-auto-failure', content: '完成当前任务' },
        prompt: '完成当前任务',
        instructions: '正常系统指令',
        maxTurns: 1,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-inline-auto-failure',
        sessionId: 'session-inline-auto-failure',
        model: 'glm-5.2',
        cwd,
        channelContext: { channel: 'web' },
        loadQueuedInterjections: async () => queued,
        evaluateAutoCompaction: () => ({
          shouldCompact: evaluations++ === 0,
          reason: 'threshold_reached',
        }),
      },
    ));

    expect(adapter.normalCalls).toBe(2);
    expect(adapter.requests).toHaveLength(3);
    expect(JSON.stringify(adapter.requests[2]?.messages)).toContain('压缩失败时的新消息');
    expect(markApplied).toHaveBeenCalledWith('run-inline-auto-failure', ['source-during-failed-compact']);
    expect(outbound).toContainEqual({
      type: 'compaction_end',
      compaction: {
        skipped: true,
        note: '自动压缩失败，已继续当前会话。',
        coveredEventCount: 0,
      },
    });
    expect(outbound.at(-1)).toEqual({ type: 'done' });

    const events = await eventStore.list('session-inline-auto-failure');
    expect(events.some((event) => event.type === 'compaction')).toBe(false);
    expect(events.filter((event) => event.type === 'run_started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'run_finished')).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'user_message',
      interjectionSourceRunId: 'source-during-failed-compact',
    }));
  });
});
