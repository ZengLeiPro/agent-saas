import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import type { EventListOptions, EventStore, PlatformEventInput } from '../runtime/runtimeEventStoreTypes.js';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  PlatformEvent,
  RunContext,
} from '../runtime/types.js';
import type { OutboundEvent } from '../types/index.js';

class SessionMapEventStore implements EventStore {
  private readonly events: PlatformEvent[] = [];

  async append(input: PlatformEventInput): Promise<PlatformEvent> {
    const event = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...input,
    } as PlatformEvent;
    this.events.push(event);
    return event;
  }

  async list(sessionId: string, options: EventListOptions = {}): Promise<PlatformEvent[]> {
    const excluded = new Set(options.excludeTypes ?? []);
    const included = options.includeTypes?.length ? new Set(options.includeTypes) : null;
    return this.events.filter((event) => (
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
    });
    await store.append({
      type: 'user_message', runId: 'source-run', sessionId: sourceSessionId,
      content: '父会话里的稳定事实',
    });
    await store.append({
      type: 'assistant_message', runId: 'source-run', sessionId: sourceSessionId,
      content: '父会话回答', model: 'gpt-5.4',
    });
    await store.append({
      type: 'assistant_tool_calls', runId: 'source-run', sessionId: sourceSessionId,
      content: '',
      toolCalls: [{ id: 'unfinished-call', name: 'Read', arguments: '{"path":"missing.md"}' }],
    });
    await store.append({
      type: 'run_finished', runId: 'source-run', sessionId: sourceSessionId,
      subtype: 'success', numTurns: 1,
    });
    const sourceBefore = await store.list(sourceSessionId);

    const adapter = new CapturingStoredAdapter();
    const findLatestResponseSessionStateBySession = vi.fn(async () => ({
      runId: 'old-hidden-run',
      lastResponseId: 'resp-should-not-be-used',
      lastResponseModel: 'gpt-5.4',
      lastResponseProfileDigest: 'profile-v1',
    }));
    const updateResponseSessionState = vi.fn(async () => undefined);
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore: store,
      approvalStore: new EventBackedApprovalStore(store, hiddenSessionId),
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
      replaySourceSessionId: sourceSessionId,
      disableResponseRelay: true,
      memoryMaintenanceMode: 'consolidation',
      model: 'gpt-5.4',
      modelRef: 'codex/gpt-5.4',
      profileConfigDigest: 'profile-v1',
      cwd,
      channelContext: { channel: 'web' },
      approvalPolicy: { autoApproveTools: true },
    }));

    expect(outbound.at(-1)).toEqual({ type: 'done' });
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]?.previousResponseId).toBeUndefined();
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

    expect(await store.list(sourceSessionId)).toEqual(sourceBefore);
    const hiddenEvents = await store.list(hiddenSessionId);
    expect(hiddenEvents.map((event) => event.type)).toEqual([
      'run_started', 'user_message', 'assistant_message', 'run_finished',
    ]);
    expect(hiddenEvents.find((event) => event.type === 'user_message'))
      .toEqual(expect.objectContaining({ content: '开始记忆审查' }));
  });
});
