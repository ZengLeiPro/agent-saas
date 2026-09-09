import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateUtilityTextWithFallback } from '../agent/titleGenerator.js';

describe('generateUtilityTextWithFallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('保留完整 Responses JSON，并按调用方设置输出上限', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'response-1',
          status: 'completed',
          output_text: '{\n  "groups": []\n}',
          usage: { input_tokens: 20, output_tokens: 8 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateUtilityTextWithFallback(
      'sessions',
      [
        {
          model: 'grouping-model',
          protocol: 'responses',
          connection: { apiKey: 'test-key', baseUrl: 'https://example.invalid/v1' },
        },
      ],
      {
        systemPrompt: 'group sessions',
        maxOutputTokens: 4096,
      },
    );

    expect(result).toBe('{\n  "groups": []\n}');
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ max_output_tokens: 4096 });
  });

  it('主模型无文本时继续尝试备用模型', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'response-empty',
            status: 'completed',
            output_text: '',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'response-fallback',
            status: 'completed',
            output_text: '{"groups":[]}',
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateUtilityTextWithFallback(
      'sessions',
      ['main', 'fallback'].map((model) => ({
        model,
        protocol: 'responses' as const,
        connection: { apiKey: 'test-key', baseUrl: 'https://example.invalid/v1' },
      })),
      { systemPrompt: 'group sessions' },
    );

    expect(result).toBe('{"groups":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
