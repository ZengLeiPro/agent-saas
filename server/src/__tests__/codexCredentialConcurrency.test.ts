import { describe, expect, it, vi } from 'vitest';

import { InMemorySecretVault } from '../security/secretVault.js';
import {
  CodexCredentialManager,
  type CodexSubscriptionRuntimeConfig,
} from '../runtime/responses/codexCredentialManager.js';

function jwt(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`;
}

describe('Codex credential concurrency', () => {
  it('进行中的旧 refresh 不会覆盖随后完成的重授权', async () => {
    let releaseRefresh!: () => void;
    let refreshStarted!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      if (body.includes('grant_type=refresh_token')) {
        refreshStarted();
        await refreshGate;
        return new Response(JSON.stringify({
          access_token: jwt('acct-primary'),
          refresh_token: 'stale-refreshed-token',
          expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const config: CodexSubscriptionRuntimeConfig = { enabled: true };
    const manager = new CodexCredentialManager({
      vault: new InMemorySecretVault(),
      getConfig: () => config,
      fetchImpl,
    });
    const original = await manager.persistLogin({
      accessToken: jwt('acct-primary'),
      refreshToken: 'refresh-old',
      idToken: jwt('acct-primary'),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    config.credentialRef = original.credentialRef;

    const refreshing = manager.getCredentials();
    await started;
    const reauthorizing = manager.persistLogin({
      accessToken: jwt('acct-primary'),
      refreshToken: 'new-login-refresh',
      idToken: jwt('acct-primary'),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }, original.credentialRef);
    releaseRefresh();

    await refreshing;
    const reauthorized = await reauthorizing;
    const current = await manager.getCredentials();

    expect(reauthorized.bundle.generation).toBe(3);
    expect(current.refreshToken).toBe('new-login-refresh');
    expect(current.generation).toBe(3);
  });
});
