import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { FileEventStore } from '../runtime/fileEventStore.js';
import { SessionContextService, SessionToolProvider } from '../runtime/sessionContext.js';
import type { ToolCallContext } from '../agent/toolRuntime.js';

async function seedStore() {
  const cwd = await mkdtemp(join(tmpdir(), 'session-context-'));
  const store = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
  await store.appendBatch?.([
    { type: 'run_started', runId: 'run-1', sessionId: 'session-1', model: 'gpt-5.5', channel: 'web' },
    { type: 'user_message', runId: 'run-1', sessionId: 'session-1', content: 'please inspect package.json' },
    {
      type: 'assistant_tool_calls',
      runId: 'run-1',
      sessionId: 'session-1',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'Read', arguments: JSON.stringify({ path: 'package.json' }) }],
    },
    { type: 'tool_result', runId: 'run-1', sessionId: 'session-1', toolCallId: 'call-1', toolName: 'Read', content: 'package content' },
    { type: 'run_finished', runId: 'run-1', sessionId: 'session-1', subtype: 'success', numTurns: 1 },
    { type: 'run_started', runId: 'run-2', sessionId: 'session-1', model: 'gpt-5.5', channel: 'web' },
  ]);
  return { cwd, store };
}

describe('SessionContextService', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  it('returns paginated and filtered raw events without replacing the source log', async () => {
    const { cwd, store } = await seedStore();
    cleanupDirs.add(cwd);
    const service = new SessionContextService(store);

    const first = await service.getEvents('session-1', { limit: 2 });
    expect(first.events.map((event) => event.type)).toEqual(['run_started', 'user_message']);
    expect(first.hasMore).toBe(true);

    const runTwo = await service.getEvents('session-1', { runId: 'run-2' });
    expect(runTwo.events).toHaveLength(1);
    expect(runTwo.events[0]?.type).toBe('run_started');

    expect(await store.list('session-1')).toHaveLength(6);
  });

  it('can retrieve tool traces and text search matches', async () => {
    const { cwd, store } = await seedStore();
    cleanupDirs.add(cwd);
    const service = new SessionContextService(store);

    expect((await service.getToolTrace('session-1', 'call-1')).map((event) => event.type)).toEqual([
      'assistant_tool_calls',
      'tool_result',
    ]);
    expect((await service.searchEvents('session-1', 'package.json')).map((event) => event.type)).toEqual([
      'user_message',
      'assistant_tool_calls',
    ]);
  });

  it('内部模型请求诊断不会暴露给 Session 工具读取或搜索', async () => {
    const { cwd, store } = await seedStore();
    cleanupDirs.add(cwd);
    await store.append({
      type: 'model_request_finished',
      runId: 'run-1',
      sessionId: 'session-1',
      diagnostic: {
        type: 'finished',
        modelRequestId: 'internal-diagnostic-id',
        attemptId: 'attempt-internal',
        attempt: 1,
        outcome: 'eof_without_terminal',
        durationMs: 100,
        errorCode: 'MODEL_SSE_EOF_WITHOUT_TERMINAL',
      },
    });
    const service = new SessionContextService(store);

    expect((await service.getRunEvents('session-1', 'run-1')).map((event) => event.type))
      .not.toContain('model_request_finished');
    expect(await service.searchEvents('session-1', 'internal-diagnostic-id')).toEqual([]);
    expect(await service.getEvents('session-1', { type: 'model_request_finished' }))
      .toEqual({ events: [], hasMore: false });
  });

  it('delegates filtered reads to EventStore query methods when available', async () => {
    const calls: string[] = [];
    const store = {
      append: async () => { throw new Error('not used'); },
      list: async () => { throw new Error('list should not be used for pushed-down queries'); },
      listPage: async (_sessionId: string, opts: unknown) => {
        calls.push(`listPage:${JSON.stringify(opts)}`);
        return { events: [], hasMore: false };
      },
      listAround: async () => {
        calls.push('listAround');
        return [];
      },
      listByRun: async () => {
        calls.push('listByRun');
        return [];
      },
      listByToolCall: async () => {
        calls.push('listByToolCall');
        return [];
      },
      search: async (_sessionId: string, _query: string, opts: unknown) => {
        calls.push(`search:${JSON.stringify(opts)}`);
        return [];
      },
    } as unknown as import('../runtime/types.js').EventStore;
    const service = new SessionContextService(store);

    await service.getEvents('session-1', { runId: 'run-1', type: 'tool_result', limit: 5 });
    await service.getEventsAround('session-1', 'event-1', 1, 2);
    await service.getRunEvents('session-1', 'run-1');
    await service.getToolTrace('session-1', 'call-1');
    await service.searchEvents('session-1', 'package');

    expect(calls).toEqual([
      'listPage:{"limit":5,"runId":"run-1","type":"tool_result","excludeTypes":["model_request_started","model_request_checkpoint","model_request_finished"]}',
      'listAround',
      'listByRun',
      'listByToolCall',
      'search:{"limit":50,"excludeTypes":["model_request_started","model_request_checkpoint","model_request_finished"]}',
    ]);
  });

  it('exposes safe session tools for the current workspace session', async () => {
    const { cwd, store } = await seedStore();
    cleanupDirs.add(cwd);
    const provider = new SessionToolProvider(new SessionContextService(store));
    const context = {
      channelContext: { channel: 'web' },
      workspace: { root: cwd, sessionId: 'session-1', executionTarget: 'server-local' },
    } as ToolCallContext;

    expect(provider.list().map((tool) => tool.id)).toEqual([
      'SessionGetEvents',
      'SessionSearchEvents',
      'SessionGetToolTrace',
    ]);
    const result = await provider.invoke({
      toolId: 'SessionGetToolTrace',
      input: { toolCallId: 'call-1' },
      authorization: { approved: true, source: 'policy_auto' },
    }, context);
    expect(result?.content).toContain('package content');
  });
});
