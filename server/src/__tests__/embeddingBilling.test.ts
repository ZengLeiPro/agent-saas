import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmbeddingProvider } from '../memory/index/embeddings.js';

const config = {
  baseUrl: 'https://embedding.example.invalid',
  apiKey: 'sk-test',
  model: 'text-embedding-test',
  dimensions: 3,
};

describe('EmbeddingProvider Billing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('每个真实 batch 前重新授权，逐批记录 usage 并最终结算 utility run', async () => {
    const beforeModelCall = vi.fn(async () => undefined);
    const recordUsage = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({
        data: body.input.map(() => ({ embedding: [1, 0, 0] })),
        usage: { prompt_tokens: body.input.length * 3, total_tokens: body.input.length * 3 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new EmbeddingProvider(config, {
      beginBillingRun: async () => ({ runId: 'utility-memory-1', beforeModelCall, recordUsage, finalize }),
    });

    const vectors = await provider.embed(Array.from({ length: 11 }, (_, i) => `text-${i}`));

    expect(vectors).toHaveLength(11);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(beforeModelCall).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenNthCalledWith(1, 'text-embedding-test', expect.objectContaining({ inputTokens: 30 }));
    expect(recordUsage).toHaveBeenNthCalledWith(2, 'text-embedding-test', expect.objectContaining({ inputTokens: 3 }));
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it('授权拒绝时不发 embedding 请求，仍释放 utility reservation', async () => {
    const finalize = vi.fn(async () => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new EmbeddingProvider(config, {
      beginBillingRun: async () => ({
        runId: 'utility-memory-2',
        beforeModelCall: async () => { throw new Error('BILLING_RUN_LIMIT_EXCEEDED'); },
        recordUsage: async () => undefined,
        finalize,
      }),
    });

    await expect(provider.embed(['blocked'])).rejects.toThrow(/BILLING_RUN_LIMIT_EXCEEDED/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});
