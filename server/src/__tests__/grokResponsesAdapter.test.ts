import { describe, expect, it, vi } from 'vitest';
import { createModelAdapterForProtocol } from '../runtime/modelAdapterFactory.js';
import type { ModelEvent } from '../runtime/types.js';
import { grokFixture } from './grokTestFixtures.js';
const context = {
  runId: 'grok-run',
  sessionId: 'grok-session',
  tenantId: 'tenant-a',
  model: 'fixture-model',
  cwd: '/tmp/grok',
  channelContext: { channel: 'web' as const },
};
const sse = (type: string, value: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
function stream(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
async function collect(source: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
describe('Grok native Responses adapter T25-T29', () => {
  it('parses fragmented UTF-8 and canonical function calls through the platform adapter and accounts usage once', async () => {
    const f = await grokFixture(1);
    const tool = {
      type: 'function_call',
      id: 'item-f',
      call_id: 'call-f',
      name: 'Read',
      arguments: '{"path":"你好.txt"}',
    };
    const fetcher = vi.fn().mockResolvedValue(
      stream(
        sse('response.output_item.added', { output_index: 0, item: { ...tool, arguments: '' } }) +
          sse('response.function_call_arguments.delta', {
            item_id: 'item-f',
            output_index: 0,
            delta: '{"path":',
          }) +
          sse('response.function_call_arguments.delta', {
            item_id: 'item-f',
            output_index: 0,
            delta: '"你好.txt"}',
          }) +
          sse('response.output_item.done', { output_index: 0, item: tool }) +
          sse('response.completed', {
            response: {
              id: 'response-fixture',
              model: 'fixture-model',
              status: 'completed',
              output: [tool],
              usage: { input_tokens: 21, output_tokens: 9 },
            },
          }),
      ),
    );
    const adapter = createModelAdapterForProtocol(
      { apiKey: 'do-not-use', baseUrl: 'https://api.x.ai/v1' },
      { protocol: 'responses', responsesTransport: 'grok_subscription' },
      { grokCredentialManager: f.manager, grokFetch: fetcher },
    );
    const events = await collect(
      adapter.stream(
        {
          model: 'fixture-model',
          messages: [
            { role: 'system', content: '平台工具由平台执行' },
            { role: 'user', content: '读取文件' },
          ],
          tools: [
            {
              id: 'Read',
              name: 'Read',
              description: 'Read file',
              parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
              },
            },
          ],
        },
        context,
      ),
    );
    expect(events.filter((e) => e.type === 'completed')).toHaveLength(1);
    expect(events.find((e) => e.type === 'completed')).toMatchObject({
      finishReason: 'tool_calls',
      usage: { inputTokens: 21, outputTokens: 9 },
      responseChained: false,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('https://cli-chat-proxy.grok.com/v1/responses');
    expect(new Headers(fetcher.mock.calls[0][1].headers).get('authorization')).not.toContain(
      'do-not-use',
    );
    expect(JSON.stringify(events)).toContain('你好.txt');
    expect(JSON.stringify(events)).not.toMatch(/fixture-access|fixture-refresh/);
  });
  it('does not declare success on missing terminal or a failure terminal and does not invisibly walk accounts', async () => {
    for (const wire of [
      sse('response.output_text.delta', { delta: 'partial' }),
      sse('response.failed', {
        response: {
          id: 'failed',
          status: 'failed',
          error: { code: 'server_error', message: 'fixture failure' },
        },
      }),
    ]) {
      const f = await grokFixture();
      const fetcher = vi.fn().mockImplementation(async () => stream(wire));
      const adapter = createModelAdapterForProtocol(
        {},
        {
          protocol: 'responses',
          responsesTransport: 'grok_subscription',
          preStreamRetryDelaysMs: [],
        },
        { grokCredentialManager: f.manager, grokFetch: fetcher },
      );
      let events: ModelEvent[] = [];
      try {
        events = await collect(
          adapter.stream(
            { model: 'fixture-model', messages: [{ role: 'user', content: 'hello' }], tools: [] },
            context,
          ),
        );
      } catch {
        /* throws are also explicit failures */
      }
      expect(events.some((e) => e.type === 'completed' && e.terminalStatus === 'completed')).toBe(
        false,
      );
      expect(
        fetcher.mock.calls.every(
          (c) =>
            new Headers(c[1].headers).get('authorization') === 'Bearer fixture-access-fixture-0',
        ),
      ).toBe(true);
    }
  });
});
