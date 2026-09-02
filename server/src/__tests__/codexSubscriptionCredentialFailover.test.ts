import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemorySecretVault } from '../security/secretVault.js';
import {
  CodexCredentialManager,
  hashAccountBinding,
  type CodexSubscriptionRuntimeConfig,
} from '../runtime/responses/codexCredentialManager.js';
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
  return { config, manager, primary, secondary };
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
      vi.fn().mockResolvedValueOnce(quotaResponse()) as unknown as typeof fetch,
    );

    const result = await transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'mixed-cooling-request',
    });
    const payload = await result.response.json() as { error: { retryAt?: string } };

    expect(result.response.status).toBe(429);
    expect(payload.error.retryAt).toBe('2026-09-02T12:05:00.000Z');
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

  it('OAuth 5xx 即使错误体包含 invalid_grant 也不会切换账号', async () => {
    const { manager } = await createFixture();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid_grant',
    }), { status: 500, headers: { 'content-type': 'application/json' } }));
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 }));
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);

    await expect(transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'oauth-5xx-request',
    })).rejects.toThrow(/OAuth refresh 失败（HTTP 500）/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await manager.getStatuses())[0]).toMatchObject({ availability: 'available' });
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
