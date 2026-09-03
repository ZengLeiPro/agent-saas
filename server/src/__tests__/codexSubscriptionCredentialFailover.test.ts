import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemorySecretVault } from '../security/secretVault.js';
import {
  CodexCredentialManager,
  hashAccountBinding,
  type CodexSubscriptionRuntimeConfig,
} from '../runtime/responses/codexCredentialManager.js';
import { InMemoryCodexCredentialRuntimeStateStore } from '../runtime/responses/codexCredentialRuntimeState.js';
import {
  CodexResponsesWebSocketPool,
  CodexWebSocketAccountUnavailableError,
} from '../runtime/responses/codexResponsesWebSocketPool.js';
import { CodexSubscriptionResponsesTransport } from '../runtime/responses/codexSubscriptionResponsesTransport.js';

function jwt(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    email: `${accountId}@example.com`,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`;
}

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
  }), { headers: { 'content-type': 'text/event-stream' } });
}

function terminalStream(id: string): Response {
  return responseStream([
    sse('response.done', {
      type: 'response.done',
      response: { id, model: 'gpt-5.4', status: 'completed', output: [] },
    }),
    'data: [DONE]\n\n',
  ]);
}

async function createFixture() {
  const vault = new InMemorySecretVault();
  const config: CodexSubscriptionRuntimeConfig = {
    enabled: true,
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    originator: 'kaiyan-agent',
  };
  const manager = new CodexCredentialManager({ vault, getConfig: () => config });
  const primary = await manager.persistLogin({
    accessToken: jwt('acct-primary'),
    refreshToken: 'refresh-primary',
    idToken: jwt('acct-primary'),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const secondary = await manager.persistLogin({
    accessToken: jwt('acct-secondary'),
    refreshToken: 'refresh-secondary',
    idToken: jwt('acct-secondary'),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  config.credentialRefs = [primary.credentialRef, secondary.credentialRef];
  return { config, manager, primary, secondary, vault };
}

async function createSingleCredentialFixture() {
  const vault = new InMemorySecretVault();
  const config: CodexSubscriptionRuntimeConfig = {
    enabled: true,
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    originator: 'kaiyan-agent',
  };
  const manager = new CodexCredentialManager({ vault, getConfig: () => config });
  const credential = await manager.persistLogin({
    accessToken: jwt('acct-only'),
    refreshToken: 'refresh-only',
    idToken: jwt('acct-only'),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  config.credentialRefs = [credential.credentialRef];
  return { manager, credential };
}

function quotaResponse(code = 'insufficient_quota'): Response {
  return new Response(JSON.stringify({
    error: { code, message: 'You have exceeded your current quota.' },
  }), { status: 429, headers: { 'content-type': 'application/json' } });
}

const context = {
  runId: 'run-codex-failover',
  sessionId: 'session-codex-failover',
  tenantId: 'kaiyan',
  model: 'gpt-5.4',
  cwd: '/tmp/codex-workspace',
  channelContext: { channel: 'web' as const },
};

describe('Codex subscription credential failover', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('只有额度不足时才按优先级切换到下一个 Codex 授权账号', async () => {
    const { config, manager, primary, secondary } = await createFixture();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(quotaResponse())
      .mockResolvedValueOnce(terminalStream('resp-secondary'));
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);
    const result = await transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'quota-fallback-request',
    });

    expect(result.response.status).toBe(200);
    await result.response.text();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization)
      .toBe(`Bearer ${jwt('acct-primary')}`);
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization)
      .toBe(`Bearer ${jwt('acct-secondary')}`);
    expect(result.continuationBinding?.accountBindingHash).toBe(hashAccountBinding('acct-secondary'));
    expect(config.credentialRefs).toEqual([primary.credentialRef, secondary.credentialRef]);
  });

  it('单个账号额度不足时保留可读的 quota 错误体', async () => {
    const { manager } = await createSingleCredentialFixture();
    const fetchMock = vi.fn().mockResolvedValueOnce(quotaResponse());
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);

    const result = await transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'single-quota-request',
    });

    expect(result.response.status).toBe(429);
    expect(await result.response.text()).toContain('insufficient_quota');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('最后一个账号的 HTTP quota 响应保留原 status、headers 和诊断内容', async () => {
    const { manager } = await createSingleCredentialFixture();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: 'insufficient_quota',
        message: 'provider-specific quota diagnostic',
        requestId: 'request-in-body',
      },
    }), {
      status: 402,
      statusText: 'Payment Required',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'request-in-header',
      },
    }));
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);

    const result = await transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'preserve-final-quota-response',
    });

    expect(result.response.status).toBe(402);
    expect(result.response.statusText).toBe('Payment Required');
    expect(result.response.headers.get('x-request-id')).toBe('request-in-header');
    expect(result.response.headers.get('retry-after')).toMatch(/^\d+$/);
    await expect(result.response.json()).resolves.toMatchObject({
      error: {
        code: 'insufficient_quota',
        message: 'provider-specific quota diagnostic',
        requestId: 'request-in-body',
        retryAt: expect.any(String),
      },
    });
  });

  it('所有账号额度不足时返回 quota 错误体和最早恢复时间', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'));
    const { config, manager } = await createFixture();
    config.quotaCooldownMinutes = 10;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(quotaResponse())
      .mockImplementationOnce(async () => {
        vi.setSystemTime(new Date('2026-09-02T12:01:00.000Z'));
        return quotaResponse();
      });
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);

    const result = await transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'all-quota-request',
    });

    expect(result.response.status).toBe(429);
    const payload = await result.response.json() as { error: { code: string; retryAt?: string } };
    expect(payload.error.code).toBe('insufficient_quota');
    expect(payload.error.retryAt).toBe('2026-09-02T12:10:00.000Z');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('新冷却账号与既有冷却账号混合时返回最早恢复时间', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'));
    const { config, manager, secondary } = await createFixture();
    config.quotaCooldownMinutes = 5;
    await manager.markQuotaCooldown(
      secondary.credentialRef,
      'insufficient_quota',
      secondary.bundle.generation,
    );
    config.quotaCooldownMinutes = 10;
    const transport = new CodexSubscriptionResponsesTransport(
      manager,
      vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'insufficient_quota', message: 'quota exhausted' },
      }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '3600' },
      })) as unknown as typeof fetch,
    );

    const result = await transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'mixed-cooling-request',
    });
    const payload = await result.response.json() as { error: { retryAt?: string } };

    expect(result.response.status).toBe(429);
    expect(payload.error.retryAt).toBe('2026-09-02T12:05:00.000Z');
    expect(result.response.headers.get('retry-after')).toBe('300');
  });

  it('额度账号进入冷却后，后续请求直接跳过并在状态接口展示', async () => {
    const { manager } = await createFixture();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(quotaResponse())
      .mockResolvedValueOnce(terminalStream('resp-secondary-first'))
      .mockResolvedValueOnce(terminalStream('resp-secondary-second'));
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);
    const request = {
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'quota-cooldown-request',
    };

    await (await transport.execute(request)).response.text();
    await (await transport.execute({ ...request, clientRequestId: 'quota-cooldown-request-2' })).response.text();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>).authorization)
      .toBe(`Bearer ${jwt('acct-secondary')}`);
    expect((await manager.getStatuses())[0]).toMatchObject({
      availability: 'quota_cooldown',
      cooldownUntil: expect.any(String),
      lastFailureCode: 'insufficient_quota',
    });
  });

  it('全部账号已冷却时不请求上游，并返回最早恢复时间', async () => {
    const { manager } = await createFixture();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(quotaResponse())
      .mockResolvedValueOnce(quotaResponse());
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);
    const request = {
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'all-cooling-request',
    };

    await (await transport.execute(request)).response.text();
    const cooling = await transport.execute({ ...request, clientRequestId: 'all-cooling-request-2' });
    const payload = await cooling.response.json() as { error: { code: string; retryAt?: string } };

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cooling.response.status).toBe(429);
    expect(payload.error.code).toBe('codex_accounts_cooling_down');
    expect(payload.error.retryAt).toBeTruthy();
  });

  it('冷却期满后自动恢复高优先级账号探测', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'));
    const { config, manager } = await createFixture();
    config.quotaCooldownMinutes = 1;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(quotaResponse())
      .mockResolvedValueOnce(terminalStream('resp-secondary'))
      .mockResolvedValueOnce(terminalStream('resp-primary-recovered'));
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);
    const request = {
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'cooldown-expiry-request',
    };

    await (await transport.execute(request)).response.text();
    vi.setSystemTime(new Date('2026-09-02T12:01:01.000Z'));
    await (await transport.execute({ ...request, clientRequestId: 'cooldown-expiry-request-2' })).response.text();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>).authorization)
      .toBe(`Bearer ${jwt('acct-primary')}`);
  });

  it('refresh token 永久失效时标记当前账号并切换到下一个', async () => {
    const { manager } = await createFixture();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid_grant',
    }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(terminalStream('resp-secondary'));
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);

    const result = await transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'auth-fallback-request',
    });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await manager.getStatuses())[0]).toMatchObject({
      availability: 'auth_unavailable',
      lastFailureCode: 'invalid_grant',
    });
  });

  it('WebSocket 明确账号停用时标记当前账号并切换到下一个', async () => {
    const { config, manager } = await createFixture();
    config.websocketEnabled = true;
    const websocketPool = {
      execute: vi.fn()
        .mockRejectedValueOnce(new CodexWebSocketAccountUnavailableError(
          'account_disabled', 'Codex account disabled',
        ))
        .mockResolvedValueOnce({
          response: terminalStream('resp-secondary'),
          wireMode: 'websocket_full',
          wireRequestBodyBytes: 100,
        }),
    } as unknown as CodexResponsesWebSocketPool;
    const fetchMock = vi.fn();
    const transport = new CodexSubscriptionResponsesTransport(
      manager, fetchMock as unknown as typeof fetch, websocketPool,
    );

    const result = await transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'websocket-account-disabled-request',
    });

    expect(result.response.status).toBe(200);
    expect(websocketPool.execute).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await manager.getStatuses())[0]).toMatchObject({
      availability: 'auth_unavailable',
      lastFailureCode: 'account_disabled',
    });
  });

  it.each([500, 502, 503, 504])('OAuth HTTP %i 即使错误体命中凭据文本也不会切换账号', async (status) => {
    const { manager } = await createFixture();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'secret not found: token 缺少',
    }), { status, headers: { 'content-type': 'application/json' } }));
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 }));
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);

    await expect(transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'oauth-5xx-request',
    })).rejects.toThrow(new RegExp(`OAuth refresh 失败（HTTP ${status}）`));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await manager.getStatuses())[0]).toMatchObject({ availability: 'available' });
  });

  it('跨重授权刷新永久失败时使用实际 generation 封禁账号', async () => {
    const { manager, primary } = await createFixture();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid_grant',
    }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        await manager.persistLogin({
          accessToken: jwt('acct-primary'), refreshToken: 'refresh-primary-gen2',
          idToken: jwt('acct-primary'), expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }, primary.credentialRef);
        return new Response('', { status: 401 });
      })
      .mockResolvedValueOnce(terminalStream('resp-secondary-after-gen2-failure'));
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);

    const result = await transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'generation-fence-request',
    });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await manager.getStatuses())[0]).toMatchObject({
      generation: 2,
      availability: 'auth_unavailable',
      lastFailureCode: 'invalid_grant',
    });
  });

  it('请求开始后调整优先级，不会改变该请求已固定的候选顺序', async () => {
    const { config, manager, primary, secondary } = await createFixture();
    let resolvePrimary!: (response: Response) => void;
    const primaryPending = new Promise<Response>((resolve) => {
      resolvePrimary = resolve;
    });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(primaryPending)
      .mockResolvedValueOnce(terminalStream('resp-old-secondary'));
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);

    const pending = transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'order-snapshot-request',
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    config.credentialRefs = [secondary.credentialRef, primary.credentialRef];
    resolvePrimary(quotaResponse());
    const result = await pending;

    expect(result.response.status).toBe(200);
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization)
      .toBe(`Bearer ${jwt('acct-secondary')}`);
  });

  it('重授权递增 generation，且旧请求不能重新封禁账号', async () => {
    const { manager, primary } = await createFixture();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    await manager.markAuthUnavailable(primary.credentialRef, 'invalid_grant', primary.bundle.generation);

    const reauthorized = await manager.persistLogin({
      accessToken: jwt('acct-primary'),
      refreshToken: 'refresh-primary-new',
      idToken: jwt('acct-primary'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }, primary.credentialRef);
    await manager.markAuthUnavailable(primary.credentialRef, 'invalid_grant', primary.bundle.generation);

    expect(reauthorized.bundle.generation).toBe(primary.bundle.generation + 1);
    expect((await manager.getStatuses())[0]).toMatchObject({ availability: 'available' });
  });

  it('凭据损坏无法解析 generation 时使用共享 fence 持久隔离账号', async () => {
    const { manager, primary, vault } = await createFixture();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    const reauthorized = await manager.persistLogin({
      accessToken: jwt('acct-primary'),
      refreshToken: 'refresh-primary-new',
      idToken: jwt('acct-primary'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }, primary.credentialRef);
    await vault.rotateSecret(primary.credentialRef, '{}', {
      actor: 'system',
      userId: '__system__',
      scopes: ['secret:codex_subscription_oauth:rotate'],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(terminalStream('resp-secondary'));
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);

    const result = await transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'corrupt-credential-request',
    });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(manager.getRuntimeState(primary.credentialRef)).resolves.toMatchObject({
      availability: 'auth_unavailable',
      credentialGeneration: reauthorized.bundle.generation,
      lastFailureCode: 'credential_invalid',
    });
  });

  it('旧凭据读取失败晚于重授权完成时不会封禁新 generation', async () => {
    const vault = new InMemorySecretVault();
    const runtimeStateStore = new InMemoryCodexCredentialRuntimeStateStore();
    const config: CodexSubscriptionRuntimeConfig = {
      enabled: true,
      endpoint: 'https://chatgpt.com/backend-api/codex/responses',
      originator: 'kaiyan-agent',
    };
    const manager = new CodexCredentialManager({ vault, runtimeStateStore, getConfig: () => config });
    const primary = await manager.persistLogin({
      accessToken: jwt('acct-primary'), refreshToken: 'refresh-primary',
      idToken: jwt('acct-primary'), expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const secondary = await manager.persistLogin({
      accessToken: jwt('acct-secondary'), refreshToken: 'refresh-secondary',
      idToken: jwt('acct-secondary'), expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    config.credentialRefs = [primary.credentialRef, secondary.credentialRef];
    await runtimeStateStore.clear(primary.credentialRef);

    const originalGetSecret = vault.getSecret.bind(vault);
    let releaseStaleRead!: () => void;
    const staleRead = new Promise<void>((resolve) => { releaseStaleRead = resolve; });
    const getSecret = vi.spyOn(vault, 'getSecret')
      .mockImplementationOnce(async () => {
        await staleRead;
        return '{}';
      })
      .mockImplementation(originalGetSecret);
    const fetchMock = vi.fn().mockResolvedValueOnce(terminalStream('resp-secondary'));
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);
    const pending = transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'stale-read-after-reauthorization-request',
    });
    await vi.waitFor(() => expect(getSecret).toHaveBeenCalledTimes(1));

    const generation2 = { ...primary.bundle, refreshToken: 'refresh-primary-new', generation: 2 };
    await vault.rotateSecret(primary.credentialRef, JSON.stringify(generation2), {
      actor: 'system', userId: '__system__', scopes: ['secret:codex_subscription_oauth:rotate'],
    });
    await runtimeStateStore.clear(primary.credentialRef, generation2.generation);
    releaseStaleRead();

    expect((await pending).response.status).toBe(200);
    await expect(manager.getRuntimeGeneration(primary.credentialRef)).resolves.toBe(2);
    await expect(manager.getRuntimeState(primary.credentialRef)).resolves.toBeUndefined();
  });

  it('非额度错误不会切换到低优先级 Codex 授权账号', async () => {
    const { manager } = await createFixture();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { code: 'insufficient_quota', message: 'temporary provider failure' } }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    ));
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);

    const result = await transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'non-quota-request',
    });

    expect(result.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
