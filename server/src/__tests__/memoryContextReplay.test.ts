import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ToolRuntime } from '../agent/toolRuntime.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import type { EventAppendContext, EventListOptions, EventStore, PlatformEventInput } from '../runtime/runtimeEventStoreTypes.js';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  PlatformEvent,
  RunContext,
} from '../runtime/types.js';
import type { OutboundEvent } from '../types/index.js';

const TENANT_ID = 'tenant-memory-context';

class SessionMapEventStore implements EventStore {
  private readonly eventsByTenant = new Map<string, PlatformEvent[]>();

  async append(input: PlatformEventInput, ctx: EventAppendContext): Promise<PlatformEvent> {
    const event = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...input,
    } as PlatformEvent;
    const events = this.eventsByTenant.get(ctx.tenantId) ?? [];
    events.push(event);
    this.eventsByTenant.set(ctx.tenantId, events);
    return event;
  }

  async list(tenantId: string, sessionId: string, options: EventListOptions = {}): Promise<PlatformEvent[]> {
    const excluded = new Set(options.excludeTypes ?? []);
    const included = options.includeTypes?.length ? new Set(options.includeTypes) : null;
    return (this.eventsByTenant.get(tenantId) ?? []).filter((event) => (
      event.sessionId === sessionId
      && !excluded.has(event.type)
      && (!included || included.has(event.type))
    ));
  }
}

class CapturingStoredAdapter implements ModelAdapter {
  readonly capabilities = { responseState: 'stored' as const };
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    yield {
      type: 'completed',
      content: '记忆审查完成',
      toolCalls: [],
      responseId: 'resp-hidden',
      usage: {
        inputTokens: 100,
        outputTokens: 4,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 0,
      },
    };
  }
}

async function collect(stream: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const cleanup = new Set<string>();
afterEach(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
  cleanup.clear();
});

describe('memory consolidation context replay', () => {
  it('从父会话完整投影，向隐藏会话落事件，并禁用 previous_response_id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'memory-context-replay-'));
    cleanup.add(cwd);
    const sourceSessionId = 'source-session';
    const hiddenSessionId = 'hidden-session';
    const store = new SessionMapEventStore();
    await store.append({
      type: 'run_started', runId: 'source-run', sessionId: sourceSessionId,
      model: 'gpt-5.4', channel: 'web',
    }, { tenantId: TENANT_ID });
    await store.append({
      type: 'user_message', runId: 'source-run', sessionId: sourceSessionId,
      content: '父会话里的稳定事实',
    }, { tenantId: TENANT_ID });
    await store.append({
      type: 'assistant_message', runId: 'source-run', sessionId: sourceSessionId,
      content: '父会话回答', model: 'gpt-5.4',
    }, { tenantId: TENANT_ID });
    await store.append({
      type: 'assistant_tool_calls', runId: 'source-run', sessionId: sourceSessionId,
      content: '',
      toolCalls: [{ id: 'unfinished-call', name: 'Read', arguments: '{"path":"missing.md"}' }],
    }, { tenantId: TENANT_ID });
    await store.append({
      type: 'run_finished', runId: 'source-run', sessionId: sourceSessionId,
      subtype: 'success', numTurns: 1,
    }, { tenantId: TENANT_ID });
    await store.append({
      type: 'user_message', runId: 'other-tenant-run', sessionId: sourceSessionId,
      content: '其他租户不可见事实',
    }, { tenantId: 'other-tenant' });
    const sourceBefore = await store.list(TENANT_ID, sourceSessionId);

    const adapter = new CapturingStoredAdapter();
    const findLatestResponseSessionStateBySession = vi.fn(async () => ({
      runId: 'old-hidden-run',
      lastResponseId: 'resp-should-not-be-used',
      lastResponseModel: 'gpt-5.4',
      lastResponseProfileDigest: 'profile-v1',
    }));
    const updateResponseSessionState = vi.fn(async () => undefined);
    const evaluatedEvents: PlatformEvent[][] = [];
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore: store,
      approvalStore: new EventBackedApprovalStore(store, hiddenSessionId, TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'hidden.jsonl')),
      runStore: {
        findLatestResponseSessionStateBySession,
        updateResponseSessionState,
      } as never,
    });

    const outbound = await collect(loop.run({
      message: { channel: 'web', chatId: hiddenSessionId, content: '开始记忆审查' },
      prompt: '开始记忆审查',
      instructions: '与父会话相同的 system prompt',
      maxTurns: 1,
      connection: { apiKey: 'test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId: 'hidden-run',
      sessionId: hiddenSessionId,
      tenantId: TENANT_ID,
      replaySourceSessionId: sourceSessionId,
      disableResponseRelay: true,
      memoryMaintenanceMode: 'consolidation',
      model: 'gpt-5.4',
      modelRef: 'codex/gpt-5.4',
      profileConfigDigest: 'profile-v1',
      cwd,
      channelContext: { channel: 'web' },
      approvalPolicy: { autoApproveTools: true },
      evaluateAutoCompaction: (events) => {
        evaluatedEvents.push(events);
        return { shouldCompact: true, reason: 'threshold_reached' };
      },
    }));

    expect(outbound.at(-1)).toEqual({ type: 'done' });
    expect(adapter.requests.length).toBeGreaterThanOrEqual(1);
    expect(adapter.requests[0]?.previousResponseId).toBeUndefined();
    expect(evaluatedEvents).toHaveLength(1);
    expect(evaluatedEvents[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: sourceSessionId, type: 'user_message' }),
      expect.objectContaining({ sessionId: hiddenSessionId, type: 'assistant_message' }),
    ]));
    expect(outbound.map((event) => event.type)).toContain('compaction_start');
    expect(findLatestResponseSessionStateBySession).not.toHaveBeenCalled();
    expect(updateResponseSessionState).not.toHaveBeenCalled();

    const messages = adapter.requests[0]!.messages;
    expect(messages).toEqual(expect.arrayContaining([
      { role: 'user', content: '父会话里的稳定事实' },
      { role: 'assistant', content: '父会话回答' },
      { role: 'user', content: '开始记忆审查' },
    ]));
    expect(messages.at(-1)).toEqual({ role: 'user', content: '开始记忆审查' });
    expect(messages.some((message) => message.role === 'assistant'
      && message.tool_calls?.some((call) => call.id === 'unfinished-call'))).toBe(true);
    expect(messages.some((message) => message.role === 'tool'
      && message.tool_call_id === 'unfinished-call'
      && message.content.includes('未形成完整结果'))).toBe(true);

    expect(messages).not.toContainEqual(expect.objectContaining({ content: '其他租户不可见事实' }));
    expect(await store.list(TENANT_ID, sourceSessionId)).toEqual(sourceBefore);
    const hiddenEvents = await store.list(TENANT_ID, hiddenSessionId);
    expect(hiddenEvents.map((event) => event.type)).toEqual([
      'run_started', 'user_message', 'assistant_message',
      'compaction_usage', 'compaction', 'run_finished',
    ]);
    expect(hiddenEvents.find((event) => event.type === 'user_message'))
      .toEqual(expect.objectContaining({ content: '开始记忆审查' }));
    const replayCheckpoint = hiddenEvents.find((event) => event.type === 'compaction');
    expect(replayCheckpoint).toEqual(expect.objectContaining({
      sessionId: hiddenSessionId,
      inline: true,
      coveredEventCount: expect.any(Number),
    }));
  });

  it('完整恢复旧工具调用与结果作为上下文，但不再次执行旧工具', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'subagent-context-replay-'));
    cleanup.add(cwd);
    const sourceSessionId = 'previous-subagent-session';
    const targetSessionId = 'continued-subagent-session';
    const store = new SessionMapEventStore();
    await store.append({
      type: 'user_message', runId: 'previous-run', sessionId: sourceSessionId,
      content: '读取事实文件',
    }, { tenantId: TENANT_ID });
    await store.append({
      type: 'assistant_tool_calls', runId: 'previous-run', sessionId: sourceSessionId,
      content: '',
      toolCalls: [{ id: 'historical-call', name: 'Read', arguments: '{"path":"事实.md"}' }],
    }, { tenantId: TENANT_ID });
    await store.append({
      type: 'tool_result', runId: 'previous-run', sessionId: sourceSessionId,
      toolCallId: 'historical-call', toolName: 'Read', content: '历史工具结果，只能作为上下文证据',
    }, { tenantId: TENANT_ID });
    await store.append({
      type: 'assistant_message', runId: 'previous-run', sessionId: sourceSessionId,
      content: '已完成首次读取', model: 'gpt-5.4',
    }, { tenantId: TENANT_ID });
    await store.append({
      type: 'run_finished', runId: 'previous-run', sessionId: sourceSessionId,
      subtype: 'success', numTurns: 1,
    }, { tenantId: TENANT_ID });
    const sourceBefore = await store.list(TENANT_ID, sourceSessionId);
    const invokeHistoricalTool = vi.fn();
    const toolRuntime: ToolRuntime = { list: () => [], invoke: invokeHistoricalTool };
    const adapter = new CapturingStoredAdapter();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore: store,
      approvalStore: new EventBackedApprovalStore(store, targetSessionId, TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'continued.jsonl')),
      toolRuntime,
    });

    const outbound = await collect(loop.run({
      message: { channel: 'web', chatId: targetSessionId, content: '基于旧结果继续分析' },
      prompt: '基于旧结果继续分析',
      instructions: '继续原任务。',
      maxTurns: 1,
      connection: { apiKey: 'test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId: 'continued-run',
      sessionId: targetSessionId,
      tenantId: TENANT_ID,
      replaySourceSessionId: sourceSessionId,
      disableResponseRelay: true,
      model: 'gpt-5.4',
      cwd,
      channelContext: { channel: 'web' },
      approvalPolicy: { autoApproveTools: true },
    }));

    expect(outbound.at(-1)).toEqual({ type: 'done' });
    expect(adapter.requests[0]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        tool_calls: [expect.objectContaining({ id: 'historical-call', function: expect.objectContaining({ name: 'Read' }) })],
      }),
      { role: 'tool', tool_call_id: 'historical-call', content: '历史工具结果，只能作为上下文证据' },
      { role: 'assistant', content: '已完成首次读取' },
      { role: 'user', content: '基于旧结果继续分析' },
    ]));
    expect(invokeHistoricalTool).not.toHaveBeenCalled();
    expect(await store.list(TENANT_ID, sourceSessionId)).toEqual(sourceBefore);
    expect((await store.list(TENANT_ID, targetSessionId)).some(event => event.type === 'tool_result')).toBe(false);
  });
});
