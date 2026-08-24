import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { FileEventStore } from '../runtime/fileEventStore.js';
import { SessionContextService, SessionToolProvider } from '../runtime/sessionContext.js';
import type { ToolCallContext } from '../agent/toolRuntime.js';

const TENANT_ID = 'tenant-session-context';

async function seedStore() {
  const cwd = await mkdtemp(join(tmpdir(), 'session-context-'));
  const store = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), TENANT_ID);
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
  ], { tenantId: TENANT_ID });
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
    const service = new SessionContextService(store, TENANT_ID);

    const first = await service.getEvents('session-1', { limit: 2 });
    expect(first.events.map((event) => event.type)).toEqual(['run_started', 'user_message']);
    expect(first.hasMore).toBe(true);

    const runTwo = await service.getEvents('session-1', { runId: 'run-2' });
    expect(runTwo.events).toHaveLength(1);
    expect(runTwo.events[0]?.type).toBe('run_started');

    expect(await store.list(TENANT_ID, 'session-1')).toHaveLength(6);
  });

  it('can retrieve tool traces and text search matches', async () => {
    const { cwd, store } = await seedStore();
    cleanupDirs.add(cwd);
    const service = new SessionContextService(store, TENANT_ID);

    expect((await service.getToolTrace('session-1', 'call-1')).map((event) => event.type)).toEqual([
      'assistant_tool_calls',
      'tool_result',
    ]);
    expect((await service.searchEvents('session-1', 'package.json')).map((event) => event.type)).toEqual([
      'user_message',
      'assistant_tool_calls',
    ]);
  });

  it('trace 可按行、Unicode 字符和关键字读取同一条完整工具结果', async () => {
    const { cwd, store } = await seedStore();
    cleanupDirs.add(cwd);
    const content = [
      '第一行',
      '第二行🙂',
      '第三行包含 NEEDLE 与上下文',
      '第四行',
      '第五行再次出现 needle',
      '第六行',
    ].join('\n');
    await store.append({
      type: 'tool_result',
      runId: 'run-1',
      sessionId: 'session-1',
      toolCallId: 'call-long',
      toolName: 'Shell',
      content,
    }, { tenantId: TENANT_ID });
    const service = new SessionContextService(store, TENANT_ID);

    const lines = await service.readToolTrace('session-1', 'call-long', { startLine: 2, lineCount: 2 });
    expect(lines).toMatchObject({
      mode: 'lines',
      startLine: 2,
      endLine: 3,
      content: '第二行🙂\n第三行包含 NEEDLE 与上下文',
      nextStartLine: 4,
    });

    const chars = await service.readToolTrace('session-1', 'call-long', { startChar: 5, charCount: 6 });
    expect(chars).toMatchObject({
      mode: 'characters',
      startChar: 5,
      endChar: 10,
      content: '第二行🙂\n第',
    });

    const search = await service.readToolTrace('session-1', 'call-long', {
      query: 'needle',
      maxMatches: 10,
      contextLines: 1,
    });
    expect(search).toMatchObject({
      mode: 'search',
      query: 'needle',
      returnedMatches: 2,
      totalMatches: 2,
      hasMore: false,
    });
    expect(search.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ line: 3, snippet: expect.stringContaining('第三行包含 NEEDLE') }),
      expect.objectContaining({ line: 5, snippet: expect.stringContaining('第五行再次出现 needle') }),
    ]));
  });

  it('trace 默认和单次读取都有硬边界，超长单行可继续按字符续读', async () => {
    const { cwd, store } = await seedStore();
    cleanupDirs.add(cwd);
    await store.append({
      type: 'tool_result',
      runId: 'run-1',
      sessionId: 'session-1',
      toolCallId: 'call-single-line',
      toolName: 'Shell',
      content: '🙂'.repeat(20_000),
    }, { tenantId: TENANT_ID });
    const service = new SessionContextService(store, TENANT_ID);

    const first = await service.readToolTrace('session-1', 'call-single-line');
    expect(first).toMatchObject({
      mode: 'lines',
      startLine: 1,
      endLine: 1,
      lineContentTruncated: true,
      nextStartChar: 5_001,
    });
    expect(Array.from(String(first.content))).toHaveLength(5_000);

    const second = await service.readToolTrace('session-1', 'call-single-line', {
      startChar: 5_001,
      charCount: 6_000,
    });
    expect(second).toMatchObject({
      mode: 'characters',
      startChar: 5_001,
      endChar: 11_000,
      nextStartChar: 11_001,
    });
    expect(Array.from(String(second.content))).toHaveLength(6_000);
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
    }, { tenantId: TENANT_ID });
    const service = new SessionContextService(store, TENANT_ID);

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
      listPage: async (_tenantId: string, _sessionId: string, opts: unknown) => {
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
      search: async (_tenantId: string, _sessionId: string, _query: string, opts: unknown) => {
        calls.push(`search:${JSON.stringify(opts)}`);
        return [];
      },
    } as unknown as import('../runtime/types.js').EventStore;
    const service = new SessionContextService(store, TENANT_ID);

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
    const provider = new SessionToolProvider(new SessionContextService(store, TENANT_ID));
    const context = {
      channelContext: { channel: 'web' },
      workspace: { root: cwd, sessionId: 'session-1', executionTarget: 'server-local' },
    } as ToolCallContext;

    expect(provider.list().map((tool) => tool.id)).toEqual([
      'SessionContext',
    ]);
    const result = await provider.invoke({
      toolId: 'SessionContext',
      input: { action: 'trace', toolCallId: 'call-1' },
      authorization: { approved: true, source: 'policy_auto' },
    }, context);
    expect(result?.content).toContain('package content');

    const normalized = await provider.invoke({
      toolId: 'SessionContext',
      input: {
        action: 'trace',
        toolCallId: 'call-1',
        query: '',
        startLine: 1,
        startChar: 1,
        charCount: 6_000,
        maxMatches: 8,
      },
      authorization: { approved: true, source: 'policy_auto' },
    }, context);
    expect(normalized?.content).toContain('"mode": "lines"');
    expect(normalized?.content).not.toContain('"mode": "characters"');
  });
});
