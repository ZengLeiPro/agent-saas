import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResponsesApiAdapter } from '../runtime/responsesApiAdapter.js';

function responseStream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  );
}

function sse(eventName: string, payload: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

describe('subagent effort Responses request body', () => {
  afterEach(() => vi.restoreAllMocks());

  it('最终请求体使用任务解析后的 effort，并覆盖 extraBody 中的旧值', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      responseStream([
        sse('response.created', {
          type: 'response.created',
          response: { id: 'r', model: 'reasoning-model' },
        }),
        sse('response.completed', {
          type: 'response.completed',
          response: {
            id: 'r',
            model: 'reasoning-model',
            status: 'completed',
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
      ]),
    );
    const adapter = new ResponsesApiAdapter(
      { apiKey: 'k', baseUrl: 'https://responses.example/v1' },
      {
        protocol: 'responses',
        reasoningEffort: 'high',
        extraBody: { reasoning: { effort: 'low' }, vendor_flag: true },
      },
    );

    for await (const _event of adapter.stream(
      {
        model: 'reasoning-model',
        messages: [{ role: 'user', content: 'q' }],
        tools: [],
      },
      {
        runId: 'run-effort',
        sessionId: 'session-effort',
        model: 'reasoning-model',
        cwd: '/tmp/workspace',
        channelContext: { channel: 'web' },
      },
    )) {
      // 消费完整流后再检查最终出站请求。
    }

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      model: 'reasoning-model',
      reasoning: { effort: 'high' },
      vendor_flag: true,
    });
  });
});
