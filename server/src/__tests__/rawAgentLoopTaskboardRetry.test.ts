import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlatformToolRuntime } from '../agent/toolRuntime.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import { ResponsesApiAdapter } from '../runtime/responsesApiAdapter.js';
import { InMemoryToolInvocationStore } from '../runtime/toolInvocationStore.js';
import type { OutboundEvent } from '../types/index.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

async function collect(stream: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('RawAgentLoop taskboard retry transaction', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });
  it('Taskboard 模型 attempt 中断后只执行成功 attempt 的 tool call 一次', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-taskboard-retry-tool-'));
    cleanupDirs.add(cwd);
    const sessionId = 'session-taskboard-retry-tool';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
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
      ], interrupted))
      .mockResolvedValueOnce(response([
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
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId),
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

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(outbound.at(-1)).toEqual({ type: 'done' });
    expect(readFileSync(join(cwd, 'retry-once.txt'), 'utf-8')).toBe('ONCE');
    const durable = await eventStore.list(sessionId);
    expect(durable.filter((event) => event.type === 'assistant_tool_calls')).toHaveLength(1);
    expect(durable.filter((event) => event.type === 'tool_result')).toHaveLength(1);
    expect(durable.filter((event) => event.type === 'tool_result')).toMatchObject([
      { toolCallId: 'call_write_once', toolName: 'Write' },
    ]);
    expect(durable.filter((event) => event.type === 'run_finished')).toMatchObject([
      { subtype: 'success' },
    ]);
  });

});
