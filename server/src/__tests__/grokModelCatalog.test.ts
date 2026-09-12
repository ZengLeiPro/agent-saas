import { describe, expect, it, vi } from 'vitest';
import {
  GrokModelCatalogService,
  parseGrokCatalog,
} from '../runtime/responses/grokModelCatalog.js';
import { isProxyRequiredEgressRequest } from '../runtime/egressRequestPolicy.js';
import { grokFixture, jsonResponse } from './grokTestFixtures.js';
describe('Grok subscription directory qualification', () => {
  it('unions individual account catalogs with eligibility and preserves source metadata', async () => {
    const f = await grokFixture();
    let call = 0;
    const fetcher = vi.fn(async () =>
      jsonResponse({
        models:
          ++call === 1
            ? [
                {
                  id: 'model-a',
                  context_window: 128000,
                  supports_reasoning_effort: true,
                  input_modalities: ['text'],
                },
              ]
            : [{ id: 'model-b', api_backend: 'responses', contextWindow: 256000 }],
      }),
    );
    const catalog = new GrokModelCatalogService(f.manager, fetcher);
    const result = await catalog.list();
    expect(result.models).toEqual([
      { id: 'model-a', eligibleCredentialRefs: [f.refs[0]] },
      { id: 'model-b', eligibleCredentialRefs: [f.refs[1]] },
    ]);
    expect(result.accounts[0].models[0]).toMatchObject({
      contextWindow: 128000,
      supportsReasoningEffort: true,
      source: 'subscription_catalog',
    });
    expect(result.accounts[1].models[0]).not.toHaveProperty('supportsReasoningEffort');
    expect(
      fetcher.mock.calls.every(
        (c) =>
          String((c as unknown as [string])[0]) === 'https://cli-chat-proxy.grok.com/v1/models',
      ),
    ).toBe(true);
    expect(
      fetcher.mock.calls.every((call) =>
        isProxyRequiredEgressRequest((call as unknown as [unknown, RequestInit])[1]),
      ),
    ).toBe(true);
  });
  it('coalesces requests and retains last known models as stale on outage without inventing eligibility', async () => {
    const f = await grokFixture(1);
    let now = 0;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'model-a' }] }))
      .mockRejectedValue(new Error('private-provider-error'));
    const catalog = new GrokModelCatalogService(f.manager, fetcher, () => now);
    await Promise.all([catalog.forAccount(f.refs[0]), catalog.forAccount(f.refs[0])]);
    expect(fetcher).toHaveBeenCalledOnce();
    now = 61000;
    const result = await catalog.list();
    expect(result.accounts[0]).toMatchObject({
      status: 'stale',
      models: [{ id: 'model-a' }],
      error: 'catalog_unavailable',
    });
    expect(result.models[0].eligibleCredentialRefs).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private-provider-error');
    f.config.enabled = false;
    f.config.credentialRefs = undefined;
    f.config.credentialRef = undefined;
    expect((await catalog.list()).models).toEqual([]);
  });
  it('invalidates eligibility after credential generation changes and never guesses missing numeric limits', async () => {
    const f = await grokFixture(1);
    const fetcher = vi.fn().mockImplementation(async () =>
      jsonResponse({
        data: [
          { id: 'model-a', context_window: '128000', max_output_tokens: Number.MAX_SAFE_INTEGER },
        ],
      }),
    );
    const catalog = new GrokModelCatalogService(f.manager, fetcher);
    const first = await catalog.forAccount(f.refs[0]);
    expect(first.models[0]).not.toHaveProperty('contextWindow');
    expect(first.models[0]).not.toHaveProperty('maxOutputTokens');
    await f.state.clear(f.refs[0], 2);
    await catalog.forAccount(f.refs[0]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('filters explicitly unsupported backends and rejects malformed IDs or directories', () => {
    expect(
      parseGrokCatalog({
        data: [
          { id: 'image-model', api_backend: 'image' },
          { id: 'chat-model', api_backend: 'responses' },
        ],
      }).map((m) => m.id),
    ).toEqual(['chat-model']);
    for (const raw of [
      {},
      { data: [{ id: 'bad\nmodel' }] },
      { models: 'not-a-list' },
      Array.from({ length: 1001 }, () => ({ id: 'x' })),
    ])
      expect(() => parseGrokCatalog(raw)).toThrow();
  });
});
