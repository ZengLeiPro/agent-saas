import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsesApiAdapter } from '../runtime/responsesApiAdapter.js';
import type { ModelEvent } from '../runtime/types.js';

function sse(eventName: string, payload: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function responseStream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const baseContext = {
  runId: 'run-policy',
  sessionId: 'session-policy',
  model: 'gpt-5.6-sol',
  cwd: '/tmp/ws',
  channelContext: { channel: 'web' as const },
};

function createAdapter(): ResponsesApiAdapter {
  return new ResponsesApiAdapter(
    { apiKey: 'sk', baseUrl: 'https://llm.kaiyan.net/v1' },
    { protocol: 'responses', preStreamRetryDelaysMs: [1] },
  );
}

describe('ResponsesApiAdapter policy failure', () => {
  afterEach(() => vi.restoreAllMocks());

  it('cyber_policy 只按结构化错误码归类且不重试', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseStream([
      sse('response.output_text.delta', { type: 'response.output_text.delta', delta: '已生成正文' }),
      sse('response.failed', {
        type: 'response.failed',
        response: {
          id: 'resp_policy',
          status: 'failed',
          error: { code: 'cyber_policy', message: 'provider policy detail' },
        },
      }),
    ]));

    const events = await collect(createAdapter().stream({
      model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'go' }], tools: [],
    }, { ...baseContext, channelContext: { channel: 'web' as const, outputTransactionMode: 'terminal_buffered' as const } }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      terminalStatus: 'failed',
      errorCode: 'cyber_policy',
      failureKind: 'policy_rejection',
      recoveryAction: 'switch_model',
      content: '已生成正文',
    });
  });

  it('错误文本包含 cyber_policy 但无可信结构化错误码时不误判', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseStream([
      sse('response.failed', {
        type: 'response.failed',
        response: {
          id: 'resp_text_only',
          status: 'failed',
          error: { message: 'Request blocked: cyber_policy' },
        },
      }),
    ]));

    const events = await collect(createAdapter().stream({
      model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'go' }], tools: [],
    }, baseContext));
    const completed = events.at(-1) as Extract<ModelEvent, { type: 'completed' }>;

    expect(completed.errorCode).toBe('MODEL_RESPONSE_FAILED');
    expect(completed.failureKind).toBeUndefined();
    expect(completed.recoveryAction).toBeUndefined();
  });
});
