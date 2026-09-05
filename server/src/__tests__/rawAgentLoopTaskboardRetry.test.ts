import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlatformToolRuntime } from '../agent/toolRuntime.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import { ResponsesApiAdapter } from '../runtime/responsesApiAdapter.js';
import { ResponsesStreamGuardError } from '../runtime/responses/responsesStreamBudget.js';
import { InMemoryToolInvocationStore } from '../runtime/toolInvocationStore.js';
import type { OutboundEvent } from '../types/index.js';
import type { ModelAdapter, ModelEvent, ModelRequest, RunContext } from '../runtime/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

async function collect(stream: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function completedResponse(responseId: string, content: string): Response {
  const frame = (eventName: string, payload: unknown) => (
    `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`
  );
  const body = [
    frame('response.created', { type: 'response.created', response: { id: responseId } }),
    frame('response.output_text.delta', { type: 'response.output_text.delta', delta: content }),
    frame('response.completed', {
      type: 'response.completed',
      response: { id: responseId, status: 'completed', usage: { input_tokens: 4, output_tokens: 1 } },
    }),
  ].join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

class NaturalCompletionAdapter implements ModelAdapter {
  calls = 0;
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    this.requests.push(request);
    yield { type: 'completed', content: `自然返回 ${this.calls}`, toolCalls: [] };
  }
}

describe('RawAgentLoop taskboard completion transaction', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });
  it.each(['network', 'guard', 'guard_failure'])('Taskboard 模型 attempt %s 中断后只执行成功 attempt 的 tool call 一次', async (kind) => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-taskboard-retry-tool-'));
    cleanupDirs.add(cwd);
    const sessionId = 'session-taskboard-retry-tool';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const encoder = new TextEncoder();
    const response = (chunks: string[], error?: Error) => {
      let index = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          const chunk = chunks[index];
          if (chunk !== undefined) {
            index += 1;
            controller.enqueue(encoder.encode(chunk));
          } else if (error) {
            controller.error(error);
          } else {
            controller.close();
          }
        },
      }));
    };
    const frame = (eventName: string, payload: unknown) => (
      `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`
    );
    const interrupted = Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response([
        frame('response.created', { type: 'response.created', response: { id: 'resp_partial_tool' } }),
        frame('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call_partial', name: 'Write' },
        }),
        frame('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path"',
        }),
        ...(kind !== 'network' ? Array.from({ length: 3 }, () => frame('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta', output_index: 0, delta: 'x'.repeat(800_000),
        })) : []),
      ], kind === 'network' ? interrupted : undefined))
      .mockResolvedValueOnce(kind === 'guard_failure'
        ? response([], new ResponsesStreamGuardError('MODEL_TOOL_ARGUMENT_LIMIT', 'second failure')) : response([
        frame('response.created', { type: 'response.created', response: { id: 'resp_tool_ok' } }),
        frame('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            call_id: 'call_write_once',
            name: 'Write',
            arguments: JSON.stringify({ path: 'retry-once.txt', content: 'ONCE' }),
          },
        }),
        frame('response.completed', {
          type: 'response.completed',
          response: { id: 'resp_tool_ok', status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } },
        }),
      ]))
      .mockResolvedValueOnce(response([
        frame('response.created', { type: 'response.created', response: { id: 'resp_final' } }),
        frame('response.output_text.delta', { type: 'response.output_text.delta', delta: '完成' }),
        frame('response.completed', {
          type: 'response.completed',
          response: { id: 'resp_final', status: 'completed', usage: { input_tokens: 4, output_tokens: 1 } },
        }),
      ]));
    const loop = new RawAgentLoop({
      modelAdapter: new ResponsesApiAdapter(
        { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        { protocol: 'responses', preStreamRetryDelaysMs: [0] },
      ),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      toolInvocationStore: new InMemoryToolInvocationStore(),
    });

    const outbound = await collect(loop.run({
      message: { channel: 'web', chatId: sessionId, content: '写文件' },
      prompt: '写文件',
      instructions: '必须调用 Write，完成后回复。',
      maxTurns: 3,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId: 'run-taskboard-retry-tool',
      sessionId,
      model: 'gpt-5.6-sol',
      cwd,
      channelContext: {
        channel: 'web',
        outputTransactionMode: 'terminal_buffered',
        user: { id: 'admin-1', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID },
      },
      approvalPolicy: { autoApproveTools: true },
    }));

    if (kind === 'guard_failure') {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const durable = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
      expect(durable.filter(event => event.type === 'assistant_tool_calls' || event.type === 'tool_result')).toHaveLength(0);
      expect(durable.filter(event => event.type === 'run_finished')).toMatchObject([
        { subtype: 'error', error: expect.stringContaining('MODEL_TOOL_ARGUMENT_LIMIT') },
      ]);
      return;
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(outbound.at(-1)).toEqual({ type: 'done' });
    expect(readFileSync(join(cwd, 'retry-once.txt'), 'utf-8')).toBe('ONCE');
    const durable = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expect(durable.filter((event) => event.type === 'assistant_tool_calls')).toHaveLength(1);
    expect(durable.filter((event) => event.type === 'tool_result')).toHaveLength(1);
    expect(durable.filter((event) => event.type === 'tool_result')).toMatchObject([
      { toolCallId: 'call_write_once', toolName: 'Write' },
    ]);
    expect(durable.filter((event) => event.type === 'run_finished')).toMatchObject([
      { subtype: 'success' },
    ]);
  });

  it('新建路径的 stored Responses 控制轮强制完整 replay 后继续', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-taskboard-responses-finish-gate-'));
    cleanupDirs.add(cwd);
    const sessionId = 'session-taskboard-responses-finish-gate';
    const runId = 'run-taskboard-responses-finish-gate';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(completedResponse('resp_finish_gate_1', '首次返回'))
      .mockResolvedValueOnce(completedResponse('resp_finish_gate_2', '显式交接后返回'));
    let transitioned = false;
    const loop = new RawAgentLoop({
      modelAdapter: new ResponsesApiAdapter(
        { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        { protocol: 'responses' },
      ),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
    });

    const outbound = await collect(loop.run({
      message: { channel: 'web', chatId: sessionId, content: '完成任务' },
      prompt: '完成任务', instructions: '必须显式交接。', maxTurns: 1,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId, sessionId, model: 'gpt-test', cwd, tenantId: DEFAULT_TENANT_ID,
      channelContext: { channel: 'web' },
      checkSuccessfulCompletion: async () => transitioned
        ? { action: 'allow' }
        : (transitioned = true, { action: 'continue', prompt: '隐藏 Responses finish 提示' }),
    }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(firstBody.previous_response_id).toBeUndefined();
    expect(secondBody.previous_response_id).toBeUndefined();
    expect(secondBody.instructions).toContain('隐藏 Responses finish 提示');
    expect(outbound.at(-1)).toEqual({ type: 'done' });
    expect(JSON.stringify(outbound)).not.toContain('隐藏 Responses finish 提示');
    const durable = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expect(JSON.stringify(durable)).not.toContain('隐藏 Responses finish 提示');
  });

  it('新建路径未显式 finish 时注入隐藏提示并在同一 Run 继续', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-taskboard-finish-gate-'));
    cleanupDirs.add(cwd);
    const sessionId = 'session-taskboard-finish-gate';
    const runId = 'run-taskboard-finish-gate';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new NaturalCompletionAdapter();
    let transitioned = false;
    const checkSuccessfulCompletion = vi.fn(async () => transitioned
      ? { action: 'allow' as const }
      : (transitioned = true, { action: 'continue' as const, prompt: '隐藏 finish 提示' }));
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
    });

    const outbound = await collect(loop.run({
      message: { channel: 'web', chatId: sessionId, content: '完成任务' },
      prompt: '完成任务', instructions: '必须显式交接。', maxTurns: 1,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId, sessionId, model: 'gpt-test', cwd, tenantId: DEFAULT_TENANT_ID,
      channelContext: { channel: 'web' }, checkSuccessfulCompletion,
    }));

    expect(adapter.calls).toBe(2);
    expect(adapter.requests[1]?.messages.at(-1)).toEqual({ role: 'system', content: '隐藏 finish 提示' });
    expect(checkSuccessfulCompletion).toHaveBeenCalledTimes(2);
    expect(outbound.at(-1)).toEqual({ type: 'done' });
    const durable = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expect(durable.filter((event) => event.type === 'run_finished')).toEqual([
      expect.objectContaining({ subtype: 'success' }),
    ]);
    expect(JSON.stringify(durable)).not.toContain('隐藏 finish 提示');
  });

  it('resume 路径的 stored Responses 控制轮强制完整 replay 后继续', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-taskboard-responses-finish-resume-'));
    cleanupDirs.add(cwd);
    await writeFile(join(cwd, 'seed.txt'), 'OK', 'utf-8');
    const sessionId = 'session-taskboard-responses-finish-resume';
    const runId = 'run-taskboard-responses-finish-resume';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const approvalStore = new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID);
    await eventStore.appendBatch([
      { type: 'user_message', runId, sessionId, content: '读取文件' },
      {
        type: 'assistant_tool_calls', runId, sessionId, content: '',
        toolCalls: [{ id: 'call-responses-resume-read', name: 'Read', arguments: '{"path":"seed.txt"}' }],
      },
    ], { tenantId: DEFAULT_TENANT_ID });
    const approval = await approvalStore.create({
      sessionId, runId, toolCallId: 'call-responses-resume-read', toolId: 'Read', toolName: 'Read',
      input: { path: 'seed.txt' },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(completedResponse('resp_finish_resume_1', '读取完成'))
      .mockResolvedValueOnce(completedResponse('resp_finish_resume_2', '交接完成'));
    let transitioned = false;
    const loop = new RawAgentLoop({
      modelAdapter: new ResponsesApiAdapter(
        { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        { protocol: 'responses' },
      ),
      eventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
    });

    const outbound = await collect(loop.resumeApproval({
      approvalId: approval.id, response: { allow: true }, instructions: '读取后显式交接。', maxTurns: 1,
    }, {
      runId, sessionId, model: 'gpt-test', cwd, tenantId: DEFAULT_TENANT_ID,
      channelContext: { channel: 'web' }, approvalPolicy: { autoApproveTools: true },
      checkSuccessfulCompletion: async () => transitioned
        ? { action: 'allow' }
        : (transitioned = true, { action: 'continue', prompt: '隐藏 Responses resume 提示' }),
    }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(secondBody.previous_response_id).toBeUndefined();
    expect(secondBody.instructions).toContain('隐藏 Responses resume 提示');
    expect(outbound.at(-1)).toEqual({ type: 'done' });
    expect(JSON.stringify(outbound)).not.toContain('隐藏 Responses resume 提示');
    const durable = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expect(JSON.stringify(durable)).not.toContain('隐藏 Responses resume 提示');
  });

  it('恢复路径未显式 finish 时同样继续原 Run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-taskboard-finish-resume-'));
    cleanupDirs.add(cwd);
    await writeFile(join(cwd, 'seed.txt'), 'OK', 'utf-8');
    const sessionId = 'session-taskboard-finish-resume';
    const runId = 'run-taskboard-finish-resume';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const approvalStore = new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID);
    await eventStore.appendBatch([
      { type: 'user_message', runId, sessionId, content: '读取文件' },
      {
        type: 'assistant_tool_calls', runId, sessionId, content: '',
        toolCalls: [{ id: 'call-resume-read', name: 'Read', arguments: '{"path":"seed.txt"}' }],
      },
    ], { tenantId: DEFAULT_TENANT_ID });
    const approval = await approvalStore.create({
      sessionId, runId, toolCallId: 'call-resume-read', toolId: 'Read', toolName: 'Read', input: { path: 'seed.txt' },
    });
    const adapter = new NaturalCompletionAdapter();
    let transitioned = false;
    const checkSuccessfulCompletion = vi.fn(async () => transitioned
      ? { action: 'allow' as const }
      : (transitioned = true, { action: 'continue' as const, prompt: '隐藏 resume finish 提示' }));
    const loop = new RawAgentLoop({
      modelAdapter: adapter, eventStore, approvalStore,
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
    });

    const outbound = await collect(loop.resumeApproval({
      approvalId: approval.id, response: { allow: true }, instructions: '读取后显式交接。', maxTurns: 1,
    }, {
      runId, sessionId, model: 'gpt-test', cwd, tenantId: DEFAULT_TENANT_ID,
      channelContext: { channel: 'web' }, approvalPolicy: { autoApproveTools: true },
      checkSuccessfulCompletion,
    }));

    expect(adapter.calls).toBe(2);
    expect(adapter.requests[1]?.messages.at(-1)).toEqual({ role: 'system', content: '隐藏 resume finish 提示' });
    expect(checkSuccessfulCompletion).toHaveBeenCalledTimes(2);
    expect(outbound.at(-1)).toEqual({ type: 'done' });
    const durable = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expect(durable.filter((event) => event.type === 'run_finished')).toEqual([
      expect.objectContaining({ subtype: 'success' }),
    ]);
    expect(JSON.stringify(durable)).not.toContain('隐藏 resume finish 提示');
  });

  it('成功收尾检查拒绝时不继续模型轮且明确失败', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-taskboard-finish-rejected-'));
    cleanupDirs.add(cwd);
    const sessionId = 'session-taskboard-finish-rejected';
    const runId = 'run-taskboard-finish-rejected';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new NaturalCompletionAdapter();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
    });

    const outbound = await collect(loop.run({
      message: { channel: 'web', chatId: sessionId, content: '完成任务' },
      prompt: '完成任务', instructions: '测试。', maxTurns: 1,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId, sessionId, model: 'gpt-test', cwd, tenantId: DEFAULT_TENANT_ID,
      channelContext: { channel: 'web' },
      checkSuccessfulCompletion: async () => ({ action: 'reject', error: 'execution already cancelled' }),
    }));

    expect(adapter.calls).toBe(1);
    expect(outbound.at(-1)).toMatchObject({ type: 'error', error: 'execution already cancelled' });
    const durable = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expect(durable.filter((event) => event.type === 'run_finished')).toEqual([
      expect.objectContaining({ subtype: 'error', error: 'execution already cancelled' }),
    ]);
  });

  it('重复自然返回且始终未 finish 时在有限纠正轮后明确失败', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-taskboard-finish-stall-'));
    cleanupDirs.add(cwd);
    const sessionId = 'session-taskboard-finish-stall';
    const runId = 'run-taskboard-finish-stall';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new NaturalCompletionAdapter();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
    });

    const outbound = await collect(loop.run({
      message: { channel: 'web', chatId: sessionId, content: '不要交接' },
      prompt: '不要交接', instructions: '测试。', maxTurns: 1,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId, sessionId, model: 'gpt-test', cwd, tenantId: DEFAULT_TENANT_ID,
      channelContext: { channel: 'web' },
      checkSuccessfulCompletion: async () => ({ action: 'continue', prompt: '仍未 finish' }),
    }));

    expect(adapter.calls).toBe(4);
    expect(outbound.at(-1)).toMatchObject({
      type: 'error',
      error: expect.stringContaining('completion protocol remained unresolved'),
    });
    const durable = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expect(durable.filter((event) => event.type === 'run_finished')).toEqual([
      expect.objectContaining({
        subtype: 'error',
        error: expect.stringContaining('completion protocol remained unresolved'),
      }),
    ]);
  });

});
