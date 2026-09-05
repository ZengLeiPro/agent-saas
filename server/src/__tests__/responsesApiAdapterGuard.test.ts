import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsesApiAdapter } from '../runtime/responsesApiAdapter.js';
import type { ModelEvent, ModelRequestDiagnostic, RunContext } from '../runtime/types.js';
import type { ResponsesTransport } from '../runtime/responses/responsesTransport.js';
import { ResponsesStreamGuardError } from '../runtime/responses/responsesStreamBudget.js';

const context: RunContext = {
  runId: 'guard-run',
  sessionId: 'guard-session',
  model: 'test',
  cwd: '/tmp',
  channelContext: { channel: 'web', outputTransactionMode: 'replaceable_draft' },
};
const request = { model: 'test', messages: [{ role: 'user' as const, content: 'go' }], tools: [] };
const connection = { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' };
const capabilities: ResponsesTransport['capabilities'] = {
  responseState: 'stateless',
  terminalOutput: 'canonical',
  usageLookup: false,
  responseDelete: false,
  encryptedReasoning: false,
  omitToolConfigurationWhenEmpty: true,
  parallelToolCalls: true,
  maxOutputTokens: false,
};
const encoder = new TextEncoder();
function response(events: unknown[], error?: Error): Response {
  let index = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (index < events.length)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[index++])}\n\n`));
        else if (error) controller.error(error);
        else controller.close();
      },
    }),
  );
}
function runaway() {
  return response([
    { type: 'response.output_text.delta', delta: '旧草稿' },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', call_id: 'old', name: 'Shell' },
    },
    ...Array.from({ length: 3 }, () => ({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: 'x'.repeat(800_000),
    })),
  ]);
}
function success() {
  return response([
    {
      type: 'response.completed',
      response: {
        id: 'ok',
        status: 'completed',
        usage: { input_tokens: 1, output_tokens: 1 },
        output: [
          { type: 'function_call', call_id: 'new', name: 'Shell', arguments: '{"command":"true"}' },
        ],
      },
    },
  ]);
}
async function collect(stream: AsyncIterable<ModelEvent>, events: ModelEvent[] = []) {
  for await (const event of stream) events.push(event);
  return events;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Responses 无限参数流事故回归', () => {
  it.each(['abort', 'timeout'])(
    '同一 chunk 内 checkpoint 等待时 %s，之后的 completed 不能交付工具',
    async (kind) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const chunks = [
        { type: 'response.created', response: { id: 'race' } },
        {
          type: 'response.completed',
          response: {
            id: 'race',
            status: 'completed',
            output: [{ type: 'function_call', call_id: 'unsafe', name: 'Shell', arguments: '{}' }],
          },
        },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join('');
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(
          async () => new Response(chunks, { headers: { 'content-type': 'text/event-stream' } }),
        );
      const events: ModelEvent[] = [];
      await expect(
        collect(
          new ResponsesApiAdapter(connection).stream(
            { ...request, signal: controller.signal },
            {
              ...context,
              recordModelRequestDiagnostic: async (d) => {
                if (d.type === 'checkpoint' && d.stage === 'response_created') {
                  if (kind === 'abort') controller.abort(new Error('user-stop'));
                  else await vi.advanceTimersByTimeAsync(15 * 60_000);
                }
              },
            },
          ),
          events,
        ),
      ).rejects.toThrow(kind === 'abort' ? 'user-stop' : 'MODEL_STREAM_IDLE_TIMEOUT');
      expect(events.some((e) => e.type === 'completed')).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(kind === 'abort' ? 1 : 2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('预算超限丢弃半截调用，只恢复一次，历史不动，诊断 request ID 连贯', async () => {
    const invalidate = vi.fn();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ response: runaway(), invalidate })
      .mockResolvedValueOnce({ response: success() });
    const transport: ResponsesTransport = {
      id: 'codex_subscription',
      capabilities,
      execute,
      computePromptCacheKey: () => undefined,
    };
    const adapter = new ResponsesApiAdapter(
      connection,
      { preStreamRetryDelaysMs: Array(10).fill(0) },
      transport,
    );
    const diagnostics: ModelRequestDiagnostic[] = [];
    const events = await collect(
      adapter.stream(request, {
        ...context,
        recordModelRequestDiagnostic: async (value) => {
          diagnostics.push(value);
        },
      }),
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(execute.mock.calls[1][0].recoveryAttempt).toBe(true);
    expect(execute.mock.calls[1][0].serializedBody).toBe(execute.mock.calls[0][0].serializedBody);
    expect(JSON.parse(execute.mock.calls[0][0].serializedBody)).not.toHaveProperty(
      'max_output_tokens',
    );
    expect(events.filter((e) => e.type === 'draft_reset')).toHaveLength(1);
    const completed = events.filter((e) => e.type === 'completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ toolCalls: [{ id: 'new', name: 'Shell' }] });
    const starts = diagnostics.filter((d) => d.type === 'started');
    expect(starts.map((d) => d.attempt)).toEqual([1, 2]);
    expect(new Set(starts.map((d) => d.modelRequestId)).size).toBe(1);
    expect(diagnostics.find((d) => d.type === 'finished')).toMatchObject({
      errorCode: 'MODEL_TOOL_ARGUMENT_LIMIT',
      willRetry: true,
      retryReason: 'stream_guard_recovery',
      streamBudget: { argumentBytes: 2_400_000 },
    });
  });
  it.each(['guard', 'network', 'http'])('恢复后 %s 失败不再借普通十轮预算重发', async (kind) => {
    const second =
      kind === 'guard'
        ? runaway()
        : kind === 'network'
          ? response([], new Error('network-failed'))
          : new Response('bad', { status: 503 });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(runaway())
      .mockResolvedValueOnce(second);
    const events: ModelEvent[] = [];
    await expect(
      collect(
        new ResponsesApiAdapter(connection, { preStreamRetryDelaysMs: Array(10).fill(0) }).stream(
          request,
          context,
        ),
        events,
      ),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'completed')).toHaveLength(0);
  });
  it('不可撤销通道已输出正文时不自动恢复', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(runaway());
    await expect(
      collect(
        new ResponsesApiAdapter(connection).stream(request, {
          ...context,
          channelContext: { channel: 'web', outputTransactionMode: 'irreversible_stream' },
        }),
      ),
    ).rejects.toThrow('MODEL_TOOL_ARGUMENT_LIMIT');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('用户在 draft_reset 后停止，不启动恢复请求', async () => {
    const controller = new AbortController();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(runaway());
    const run = async () => {
      for await (const event of new ResponsesApiAdapter(connection).stream(
        { ...request, signal: controller.signal },
        context,
      )) {
        if (event.type === 'draft_reset') controller.abort();
      }
    };
    await expect(run()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('HTTP 首帧之前的 guard 错误最多一次，且保留专用错误码', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new ResponsesStreamGuardError('MODEL_STREAM_DEADLINE', 'bounded'));
    await expect(
      collect(
        new ResponsesApiAdapter(connection, { preStreamRetryDelaysMs: Array(10).fill(0) }).stream(
          request,
          context,
        ),
      ),
    ).rejects.toThrow('MODEL_STREAM_DEADLINE');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
