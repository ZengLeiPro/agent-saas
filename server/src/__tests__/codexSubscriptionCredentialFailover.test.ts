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
  afterEach(() => vi.restoreAllMocks());

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

  it('所有账号额度不足时保留最后一个 quota 错误体', async () => {
    const { manager } = await createFixture();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(quotaResponse())
      .mockResolvedValueOnce(quotaResponse());
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);

    const result = await transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'all-quota-request',
    });

    expect(result.response.status).toBe(429);
    expect(await result.response.text()).toContain('insufficient_quota');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('非额度错误不会切换到低优先级 Codex 授权账号', async () => {
    const { manager } = await createFixture();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { code: 'server_error', message: 'temporary provider failure' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    ));
    const transport = new CodexSubscriptionResponsesTransport(manager, fetchMock as unknown as typeof fetch);

    const result = await transport.execute({
      serializedBody: JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hello' }] }),
      context,
      clientRequestId: 'non-quota-request',
    });

    expect(result.response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
