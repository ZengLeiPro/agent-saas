import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResponsesApiAdapter } from '../runtime/responsesApiAdapter.js';
import type { ModelEvent, ModelRequestDiagnostic } from '../runtime/types.js';
import {
  ResponsesTransportStreamError,
  type ResponsesTransport,
} from '../runtime/responses/responsesTransport.js';

function sse(eventName: string, payload: unknown): string {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return `event: ${eventName}\ndata: ${data}\n\n`;
}

function responseStream(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), init);
}

function responseStreamError(chunks: string[], error: Error, init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk !== undefined) {
        index += 1;
        controller.enqueue(encoder.encode(chunk));
      } else {
        controller.error(error);
      }
    },
  }), init);
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const baseContext = {
  runId: 'run-1',
  sessionId: 'session-12345678',
  model: 'doubao-seed-2.0-pro',
  cwd: '/tmp/ws',
  channelContext: { channel: 'web' as const },
};

describe('ResponsesApiAdapter retry transactions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it('Taskboard terminal_buffered 丢弃中断 attempt 的半截 function_call，只交付成功工具调用', async () => {
    // 复刻生产会话 e77bf799 故障形态：流只吐了 output_item.added + 参数 delta 就被掐断。
    vi.useFakeTimers();
    const streamError = Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(responseStreamError([
        sse('response.created', { type: 'response.created', response: { id: 'resp_partial_call' } }),
        sse('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call_partial', name: 'Shell' },
        }),
        sse('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: '{"comm',
        }),
      ], streamError))
      .mockResolvedValueOnce(responseStream([
        sse('response.created', { type: 'response.created', response: { id: 'resp_call_recovered' } }),
        sse('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call_ok', name: 'Shell' },
        }),
        sse('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call_ok', name: 'Shell', arguments: '{"command":"ls"}' },
        }),
        sse('response.completed', {
          type: 'response.completed',
          response: {
            id: 'resp_call_recovered',
            status: 'completed',
            usage: { input_tokens: 8, output_tokens: 4 },
          },
        }),
      ]));
    const diagnostics: ModelRequestDiagnostic[] = [];
    const adapter = new ResponsesApiAdapter(
      { apiKey: 'sk', baseUrl: 'https://llm.kaiyan.net/v1' },
      { protocol: 'responses', preStreamRetryDelaysMs: [500] },
    );

    const resultPromise = collect(adapter.stream({
      model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'go' }], tools: [],
    }, {
      ...baseContext,
      channelContext: { channel: 'web', outputTransactionMode: 'terminal_buffered' },
      recordModelRequestDiagnostic: async (event) => { diagnostics.push(event); },
    }));
    await vi.runAllTimersAsync();
    const events = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type !== 'completed')).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      toolCalls: [{ id: 'call_ok', name: 'Shell', arguments: '{"command":"ls"}' }],
      modelRequestAttemptCount: 2,
    });
    expect(diagnostics.filter((event) => event.type === 'finished')).toMatchObject([
      {
        attempt: 1,
        outcome: 'stream_error',
        errorCode: 'MODEL_STREAM_READ_ERROR',
        willRetry: true,
      },
      { attempt: 2, outcome: 'completed' },
    ]);
  });

  it('Taskboard terminal_buffered 丢弃中断 attempt 的思考与正文，只提交成功 attempt', async () => {
    vi.useFakeTimers();
    const streamError = Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(responseStreamError([
        sse('response.created', { type: 'response.created', response: { id: 'resp_taskboard_partial' } }),
        sse('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta',
          delta: '失败 attempt 思考',
        }),
        sse('response.output_text.delta', {
          type: 'response.output_text.delta',
          delta: '失败 attempt 正文',
        }),
      ], streamError))
      .mockResolvedValueOnce(responseStream([
        sse('response.created', { type: 'response.created', response: { id: 'resp_taskboard_ok' } }),
        sse('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta',
          delta: '成功 attempt 思考',
        }),
        sse('response.output_text.delta', {
          type: 'response.output_text.delta',
          delta: '成功 attempt 正文',
        }),
        sse('response.completed', {
          type: 'response.completed',
          response: {
            id: 'resp_taskboard_ok',
            status: 'completed',
            usage: { input_tokens: 8, output_tokens: 3 },
          },
        }),
      ]));
    const diagnostics: ModelRequestDiagnostic[] = [];
    const adapter = new ResponsesApiAdapter(
      { apiKey: 'sk', baseUrl: 'https://llm.kaiyan.net/v1' },
      { protocol: 'responses', preStreamRetryDelaysMs: [500] },
    );

    const resultPromise = collect(adapter.stream({
      model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'go' }], tools: [],
    }, {
      ...baseContext,
      channelContext: { channel: 'web', outputTransactionMode: 'terminal_buffered' },
      recordModelRequestDiagnostic: async (event) => { diagnostics.push(event); },
    }));
    await vi.runAllTimersAsync();
    const events = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      { type: 'thinking_delta', content: '成功 attempt 思考' },
      { type: 'text_delta', content: '成功 attempt 正文' },
      expect.objectContaining({
        type: 'completed',
        content: '成功 attempt 正文',
        terminalStatus: 'completed',
        modelRequestAttemptCount: 2,
      }),
    ]);
    const started = diagnostics.filter((event) => event.type === 'started');
    expect(started.map((event) => event.attempt)).toEqual([1, 2]);
    expect(new Set(started.map((event) => event.modelRequestId)).size).toBe(1);
    expect(new Set(started.map((event) => event.attemptId)).size).toBe(2);
    expect(started.every((event) => event.outputTransactionMode === 'terminal_buffered')).toBe(true);
    expect(diagnostics.filter((event) => event.type === 'finished')).toMatchObject([
      {
        attempt: 1,
        outcome: 'stream_error',
        errorCode: 'MODEL_STREAM_READ_ERROR',
        outputTransactionMode: 'terminal_buffered',
        hasDeliveredOutput: false,
        officialTerminalReceived: false,
        retryReason: 'transient_stream_interrupt',
        willRetry: true,
      },
      { attempt: 2, outcome: 'completed', outputTransactionMode: 'terminal_buffered' },
    ]);
  });

  it('Taskboard terminal_buffered 重试预算耗尽后 attempt 数准确并明确失败', async () => {
    vi.useFakeTimers();
    const streamError = Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(responseStreamError([
        sse('response.created', { type: 'response.created', response: { id: 'resp_budget_1' } }),
        sse('response.output_text.delta', { type: 'response.output_text.delta', delta: '丢弃一' }),
      ], streamError))
      .mockResolvedValueOnce(responseStreamError([
        sse('response.created', { type: 'response.created', response: { id: 'resp_budget_2' } }),
        sse('response.output_text.delta', { type: 'response.output_text.delta', delta: '丢弃二' }),
      ], streamError));
    const diagnostics: ModelRequestDiagnostic[] = [];
    const adapter = new ResponsesApiAdapter(
      { apiKey: 'sk', baseUrl: 'https://llm.kaiyan.net/v1' },
      { protocol: 'responses', preStreamRetryDelaysMs: [500] },
    );

    const resultPromise = collect(adapter.stream({
      model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'go' }], tools: [],
    }, {
      ...baseContext,
      channelContext: { channel: 'web', outputTransactionMode: 'terminal_buffered' },
      recordModelRequestDiagnostic: async (event) => { diagnostics.push(event); },
    }));
    const rejection = expect(resultPromise).rejects.toThrow('terminated');
    await vi.runAllTimersAsync();
    await rejection;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(diagnostics.filter((event) => event.type === 'started').map((event) => event.attempt)).toEqual([1, 2]);
    expect(diagnostics.filter((event) => event.type === 'finished')).toMatchObject([
      {
        attempt: 1,
        errorCode: 'MODEL_STREAM_READ_ERROR',
        retryReason: 'transient_stream_interrupt',
        willRetry: true,
      },
      {
        attempt: 2,
        errorCode: 'MODEL_STREAM_READ_ERROR',
        retryBlockedReason: 'retry_budget_exhausted',
      },
    ]);
  });

  it('WebSocket 中断细节进入 model_request_finished 且不记录敏感请求内容', async () => {
    vi.useFakeTimers();
    const socketError = new ResponsesTransportStreamError(
      'Codex WebSocket error without diagnostic detail; closed before terminal event',
      {
        wireMode: 'websocket_full',
        clientRequestId: 'request-attempt-secret',
        webSocketErrorEmpty: true,
        closeCode: 1006,
        closeReason: 'proxy reset https://proxy.test/socket?token=secret-query Cookie=session-secret {"access_token":"json-secret","authorization":"Bearer auth-secret"}',
        requestDurationMs: 206_853,
        frameCount: 2,
        lastSequenceNumber: 2,
        officialTerminalReceived: false,
      },
    );
    let executeCount = 0;
    const transport: ResponsesTransport = {
      id: 'codex_subscription',
      capabilities: {
        responseState: 'stateless',
        terminalOutput: 'canonical',
        usageLookup: false,
        responseDelete: false,
        encryptedReasoning: false,
        omitToolConfigurationWhenEmpty: false,
        parallelToolCalls: true,
        maxOutputTokens: true,
      },
      computePromptCacheKey: () => undefined,
      execute: async () => {
        executeCount += 1;
        if (executeCount === 1) {
          return {
            response: responseStreamError([
              sse('response.created', { type: 'response.created', sequence_number: 1, response: { id: 'resp_ws' } }),
              sse('response.reasoning_summary_text.delta', {
                type: 'response.reasoning_summary_text.delta', sequence_number: 2, delta: '未提交思考',
              }),
            ], socketError),
            wireMode: 'websocket_full',
          };
        }
        return {
          response: responseStream([
            sse('response.created', { type: 'response.created', response: { id: 'resp_ws_ok' } }),
            sse('response.output_text.delta', { type: 'response.output_text.delta', delta: '恢复成功' }),
            sse('response.completed', {
              type: 'response.completed',
              response: { id: 'resp_ws_ok', status: 'completed', usage: { input_tokens: 4, output_tokens: 2 } },
            }),
          ]),
          wireMode: 'websocket_full',
        };
      },
    };
    const diagnostics: ModelRequestDiagnostic[] = [];
    const adapter = new ResponsesApiAdapter(
      { apiKey: 'unused', baseUrl: 'https://unused.invalid' },
      { protocol: 'responses', preStreamRetryDelaysMs: [500] },
      transport,
    );

    const resultPromise = collect(adapter.stream({
      model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'sensitive prompt must not persist' }], tools: [],
    }, {
      ...baseContext,
      channelContext: { channel: 'web', outputTransactionMode: 'terminal_buffered' },
      recordModelRequestDiagnostic: async (event) => { diagnostics.push(event); },
    }));
    await vi.runAllTimersAsync();
    const events = await resultPromise;

    expect(events.some((event) => event.type === 'thinking_delta' && event.content === '未提交思考')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'completed', content: '恢复成功' });
    expect(diagnostics.filter((event) => event.type === 'finished')[0]).toMatchObject({
      outcome: 'stream_error',
      errorCode: 'MODEL_STREAM_READ_ERROR',
      outputTransactionMode: 'terminal_buffered',
      wireMode: 'websocket_full',
      hasDeliveredOutput: false,
      officialTerminalReceived: false,
      webSocketErrorEmpty: true,
      webSocketCloseCode: 1006,
      webSocketCloseReason: 'proxy reset https://proxy.test/socket?[REDACTED] Cookie=[REDACTED] {"access_token":"[REDACTED]","authorization":"[REDACTED]"}',
      webSocketRequestDurationMs: 206_853,
      webSocketFrameCount: 2,
      webSocketLastSequenceNumber: 2,
      retryReason: 'transient_stream_interrupt',
      willRetry: true,
    });
    expect(JSON.stringify(diagnostics)).not.toContain('sensitive prompt must not persist');
    expect(JSON.stringify(diagnostics)).not.toContain('request-attempt-secret');
    expect(JSON.stringify(diagnostics)).not.toContain('secret-query');
    expect(JSON.stringify(diagnostics)).not.toContain('session-secret');
    expect(JSON.stringify(diagnostics)).not.toContain('json-secret');
    expect(JSON.stringify(diagnostics)).not.toContain('auth-secret');
  });

  it('已交付正文后流读取错误，Web 撤销草稿并在统一预算内恢复', async () => {
    vi.useFakeTimers();
    const streamError = Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(responseStreamError([
        sse('response.created', { type: 'response.created', response: { id: 'resp_draft_stream' } }),
        sse('response.output_text.delta', { type: 'response.output_text.delta', delta: '部分正文' }),
      ], streamError))
      .mockResolvedValueOnce(responseStream([
        sse('response.created', { type: 'response.created', response: { id: 'resp_draft_recovered' } }),
        sse('response.output_text.delta', { type: 'response.output_text.delta', delta: '完整回复' }),
        sse('response.completed', {
          type: 'response.completed',
          response: {
            id: 'resp_draft_recovered',
            status: 'completed',
            usage: { input_tokens: 8, output_tokens: 2 },
          },
        }),
      ]));
    const diagnostics: ModelRequestDiagnostic[] = [];
    const adapter = new ResponsesApiAdapter(
      { apiKey: 'sk', baseUrl: 'https://llm.kaiyan.net/v1' },
      { protocol: 'responses', preStreamRetryDelaysMs: [500] },
    );

    const resultPromise = collect(adapter.stream({
      model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'go' }], tools: [],
    }, {
      ...baseContext,
      channelContext: { channel: 'web', outputTransactionMode: 'replaceable_draft' },
      recordModelRequestDiagnostic: async (event) => { diagnostics.push(event); },
    }));
    await vi.runAllTimersAsync();
    const events = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      { type: 'text_delta', content: '部分正文' },
      { type: 'draft_reset', attempt: 1 },
      { type: 'text_delta', content: '完整回复' },
      expect.objectContaining({
        type: 'completed',
        content: '完整回复',
        terminalStatus: 'completed',
        modelRequestAttemptCount: 2,
      }),
    ]);
    expect(diagnostics.filter((event) => event.type === 'finished')).toMatchObject([
      {
        attempt: 1,
        outcome: 'stream_error',
        errorCode: 'MODEL_STREAM_READ_ERROR',
        willRetry: true,
      },
      { attempt: 2, outcome: 'completed' },
    ]);
  });

});
