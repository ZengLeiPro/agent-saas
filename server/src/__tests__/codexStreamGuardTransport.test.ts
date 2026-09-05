import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySecretVault } from '../security/secretVault.js';
import {
  CodexCredentialManager,
  type CodexSubscriptionRuntimeConfig,
} from '../runtime/responses/codexCredentialManager.js';
import { CodexSubscriptionResponsesTransport } from '../runtime/responses/codexSubscriptionResponsesTransport.js';
import {
  CodexResponsesWebSocketPool,
  CodexWebSocketUnavailableError,
} from '../runtime/responses/codexResponsesWebSocketPool.js';
import { executeCodexCredentialFailover } from '../runtime/responses/codexCredentialFailover.js';
import { ResponsesStreamGuardError } from '../runtime/responses/responsesStreamBudget.js';

const input = {
  serializedBody: JSON.stringify({ model: 'test', input: [], tools: [], stream: true }),
  clientRequestId: 'guard',
  context: {
    runId: 'r',
    sessionId: 's',
    model: 'test',
    cwd: '/tmp',
    channelContext: { channel: 'web' as const },
  },
};
async function fixture() {
  const config: CodexSubscriptionRuntimeConfig = { enabled: true, websocketEnabled: true };
  const manager = new CodexCredentialManager({
    vault: new InMemorySecretVault(),
    getConfig: () => config,
  });
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' },
    }),
  ).toString('base64url')}.test`;
  const stored = await manager.persistLogin({
    accessToken: token,
    idToken: token,
    refreshToken: 'test-refresh',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  config.credentialRef = stored.credentialRef;
  return { config, manager };
}
afterEach(() => {
  vi.restoreAllMocks();
});
describe('guard 恢复不发生隐式传输重发', () => {
  it('首帧前专用预算错误不包装成 WS Unavailable，也不回退 SSE', async () => {
    const { manager } = await fixture();
    const fetch = vi.fn();
    const execute = vi
      .fn()
      .mockRejectedValue(new ResponsesStreamGuardError('MODEL_STREAM_WIRE_LIMIT', 'limit'));
    const transport = new CodexSubscriptionResponsesTransport(manager, fetch, {
      execute,
    } as unknown as CodexResponsesWebSocketPool);
    await expect(transport.execute(input)).rejects.toMatchObject({
      code: 'MODEL_STREAM_WIRE_LIMIT',
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('唯一恢复请求遇普通 WS 错误也不能回退 SSE', async () => {
    const { manager } = await fixture();
    const fetch = vi.fn();
    const execute = vi
      .fn()
      .mockRejectedValue(new CodexWebSocketUnavailableError('unavailable', 'connection_closed'));
    const transport = new CodexSubscriptionResponsesTransport(manager, fetch, {
      execute,
    } as unknown as CodexResponsesWebSocketPool);
    await expect(transport.execute({ ...input, recoveryAttempt: true })).rejects.toThrow(
      'unavailable',
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('唯一恢复请求遇 401 不再刷新重发', async () => {
    const { manager, config } = await fixture();
    config.websocketEnabled = false;
    const fetch = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const result = await new CodexSubscriptionResponsesTransport(manager, fetch).execute({
      ...input,
      recoveryAttempt: true,
    });
    expect(result.response.status).toBe(401);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('唯一恢复请求遇限额不再换下一个账号重新请求', async () => {
    const credentials = {
      getRuntimeState: vi.fn(),
      getCredentialsForCredential: vi.fn().mockResolvedValue({ accountId: 'a', generation: 1 }),
    };
    const execute = vi.fn().mockResolvedValue({
      response: new Response('{"error":{"code":"usage_limit_reached"}}', { status: 429 }),
    });
    const result = await executeCodexCredentialFailover({
      request: { ...input, recoveryAttempt: true },
      credentials: credentials as unknown as CodexCredentialManager,
      credentialRefs: ['a', 'b'],
      executeWithCredential: execute,
    });
    expect(result.response.status).toBe(429);
    expect(execute).toHaveBeenCalledOnce();
  });
});
