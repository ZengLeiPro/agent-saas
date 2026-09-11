import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrokSubscriptionResponsesTransport } from '../runtime/responses/grokSubscriptionResponsesTransport.js';
import { GrokModelCatalogService } from '../runtime/responses/grokModelCatalog.js';
import { GROK_RESPONSES_ENDPOINT } from '../runtime/responses/grokProtocol.js';
import { normalizeGrokRequest } from '../runtime/responses/grokRequestNormalization.js';
import { createModelAdapterForProtocol } from '../runtime/modelAdapterFactory.js';
import { grokFixture, jsonResponse } from './grokTestFixtures.js';
const context = {
  runId: 'grok-run',
  sessionId: 'grok-session',
  tenantId: 'tenant-a',
  model: 'fixture-model',
  cwd: '/tmp/grok',
  channelContext: { channel: 'web' as const },
};
const request = {
  serializedBody: JSON.stringify({
    model: 'fixture-model',
    input: [{ role: 'user', content: 'hello' }],
    tools: [],
    stream: true,
  }),
  clientRequestId: 'fixture-request',
  context,
};
afterEach(() => vi.restoreAllMocks());
describe('Grok ordered subscription transport T01-T07, T25, T27-T28, T33', () => {
  it('uses A on every request until order changes and never consumes B on success', async () => {
    const f = await grokFixture(3);
    const fetcher = vi.fn(async () => new Response('fixture'));
    const transport = new GrokSubscriptionResponsesTransport(f.manager, fetcher);
    await transport.execute(request);
    await transport.execute(request);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.every(
        (c) =>
          new Headers((c as unknown as [unknown, RequestInit])[1]?.headers).get('Authorization') ===
          'Bearer fixture-access-fixture-0',
      ),
    ).toBe(true);
    f.config.credentialRefs = [f.refs[1], f.refs[0], f.refs[2]];
    f.config.credentialRef = f.refs[1];
    await transport.execute(request);
    const call = fetcher.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(call[0]).toBe(GROK_RESPONSES_ENDPOINT);
    expect(new Headers(call[1].headers).get('authorization')).toBe(
      'Bearer fixture-access-fixture-1',
    );
  });
  it('cools explicit exhausted credits, releases the rejected response and skips it next time', async () => {
    const f = await grokFixture();
    const rejected = jsonResponse(
      { error: { message: 'You have used all available credits' } },
      402,
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(rejected)
      .mockImplementation(async () => new Response('ok'));
    const transport = new GrokSubscriptionResponsesTransport(f.manager, fetcher);
    await transport.execute(request);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(rejected.bodyUsed).toBe(true);
    expect(await f.manager.getRuntimeState(f.refs[0])).toMatchObject({
      availability: 'quota_cooldown',
    });
    await transport.execute(request);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await f.state.markQuotaCooldown(
      f.refs[0],
      new Date(Date.now() - 100).toISOString(),
      'quota',
      1,
    );
    await transport.execute(request);
    expect(new Headers(fetcher.mock.calls.at(-1)![1].headers).get('authorization')).toBe(
      'Bearer fixture-access-fixture-0',
    );
  });
  it.each([429, 403, 500])(
    'does not walk the pool or alter account health for ordinary HTTP %s',
    async (status) => {
      const f = await grokFixture();
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { message: 'Too many requests; fixture-secret-token' } }, status),
        );
      const result = await new GrokSubscriptionResponsesTransport(f.manager, fetcher).execute(
        request,
      );
      expect(result.response.status).toBe(status);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(await f.manager.getRuntimeState(f.refs[0])).toBeUndefined();
      expect(await result.response.text()).not.toContain('fixture-secret-token');
    },
  );
  it('keeps HTML challenges and network failures bounded and does not use another billing provider', async () => {
    const f = await grokFixture();
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response('<html>private challenge</html>', {
          status: 403,
          headers: { 'content-type': 'text/html' },
        }),
      );
    expect(
      (await new GrokSubscriptionResponsesTransport(f.manager, fetcher).execute(request)).response
        .status,
    ).toBe(403);
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockReset().mockRejectedValue(new Error('fixture network'));
    await expect(
      new GrokSubscriptionResponsesTransport(f.manager, fetcher).execute(request),
    ).rejects.toThrow('fixture network');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('refreshes at most once on 401; recovery attempts do not refresh or rotate', async () => {
    const f = await grokFixture(1);
    const refresh = vi
      .spyOn(f.oauth, 'refresh')
      .mockImplementation(async (old) => ({ ...old, accessToken: 'fixture-new' }));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(new Response('ok'));
    const transport = new GrokSubscriptionResponsesTransport(f.manager, fetcher);
    const result = await transport.execute(request);
    expect(result.authRetryCount).toBe(1);
    expect(refresh).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockReset().mockResolvedValue(jsonResponse({}, 401));
    await transport.execute({ ...request, recoveryAttempt: true });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('skips unavailable accounts and reports earliest cooldown when no candidates remain', async () => {
    const f = await grokFixture();
    await f.manager.markAuthUnavailable(f.refs[0], 'invalid_grant', 1);
    const until = await f.manager.markQuotaCooldown(f.refs[1], 'quota', 1);
    const fetcher = vi.fn();
    const result = await new GrokSubscriptionResponsesTransport(f.manager, fetcher).execute(
      request,
    );
    expect(result.response.status).toBe(429);
    expect(await result.response.json()).toMatchObject({
      error: { code: 'grok_accounts_cooling_down', retryAt: until },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('never starts after cancellation and stops before failover when cancelled during rejection', async () => {
    const f = await grokFixture();
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    await expect(
      new GrokSubscriptionResponsesTransport(f.manager, fetcher).execute({
        ...request,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const live = new AbortController();
    fetcher.mockImplementation(async () => {
      live.abort();
      return jsonResponse({ error: { message: 'used all available credits' } }, 402);
    });
    await expect(
      new GrokSubscriptionResponsesTransport(f.manager, fetcher).execute({
        ...request,
        signal: live.signal,
      }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('skips a proven model-ineligible account without marking it as broken', async () => {
    const f = await grokFixture();
    const catalog = new GrokModelCatalogService(f.manager, vi.fn());
    vi.spyOn(catalog, 'forAccount').mockImplementation(
      async (ref) =>
        ({
          credentialRef: ref,
          status: 'fresh',
          models: ref === f.refs[0] ? [] : [{ id: 'fixture-model' }],
          collectedAt: new Date().toISOString(),
        }) as Awaited<ReturnType<GrokModelCatalogService['forAccount']>>,
    );
    const fetcher = vi.fn().mockResolvedValue(new Response('ok'));
    await new GrokSubscriptionResponsesTransport(f.manager, fetcher, catalog).execute(request);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(new Headers(fetcher.mock.calls[0][1].headers).get('authorization')).toBe(
      'Bearer fixture-access-fixture-1',
    );
    expect(await f.manager.getRuntimeState(f.refs[0])).toBeUndefined();
  });
  it('isolates tenant/session/account bindings and drops only opaque state on mismatch', async () => {
    const f = await grokFixture();
    const fetcher = vi.fn().mockImplementation(async () => new Response('ok'));
    const transport = new GrokSubscriptionResponsesTransport(f.manager, fetcher);
    const a = await transport.getContinuationBindingForRequest({ context, model: 'fixture-model' });
    const b = await transport.getContinuationBindingForRequest({
      context: { ...context, tenantId: 'tenant-b' },
      model: 'fixture-model',
    });
    const c = await transport.getContinuationBindingForRequest({
      context: { ...context, sessionId: 'second' },
      model: 'fixture-model',
    });
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
    f.config.credentialRefs = [f.refs[1], f.refs[0]];
    f.config.credentialRef = f.refs[1];
    const history = [
      { type: 'reasoning', encrypted_content: 'private-opaque' },
      { type: 'function_call', call_id: 'done-tool', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'done-tool', output: 'already executed' },
    ];
    await transport.execute({
      ...request,
      expectedContinuationBinding: a,
      serializedBody: JSON.stringify({
        model: 'fixture-model',
        input: history,
        previous_response_id: 'old-response',
      }),
    });
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.input).toEqual(history.slice(1));
    expect(body).not.toHaveProperty('previous_response_id');
  });
  it('rejects protocol mismatches and unverified media instead of silently using an API Key', () => {
    expect(() =>
      createModelAdapterForProtocol(
        { apiKey: 'must-not-use', baseUrl: 'https://api.x.ai/v1' },
        { responsesTransport: 'grok_subscription', protocol: 'chat_completions' },
      ),
    ).toThrow('fallback is forbidden');
    expect(() =>
      normalizeGrokRequest(
        {
          model: 'test',
          input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'fixture' }] }],
        },
        true,
      ),
    ).toThrow('image_capability_unverified');
    expect(() =>
      normalizeGrokRequest({ model: 'test', input: [], reasoning: { effort: 'high' } }, true),
    ).toThrow('reasoning_effort_capability_unverified');
  });
});
