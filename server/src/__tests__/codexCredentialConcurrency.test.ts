import { describe, expect, it, vi } from 'vitest';

import { HttpSecretVault, InMemorySecretVault } from '../security/secretVault.js';
import {
  CodexCredentialManager,
  type CodexCredentialLock,
  LocalCodexCredentialLock,
  type CodexSubscriptionRuntimeConfig,
} from '../runtime/responses/codexCredentialManager.js';
import {
  InMemoryCodexCredentialRuntimeStateStore,
} from '../runtime/responses/codexCredentialRuntimeState.js';

const systemCaller = (operation: 'read' | 'write' | 'rotate' | 'revoke') => ({
  actor: 'system' as const,
  userId: '__system__',
  scopes: [`secret:codex_subscription_oauth:${operation}`],
});

class LockAwareRuntimeStateStore extends InMemoryCodexCredentialRuntimeStateStore {
  constructor(private readonly isLockHeld: () => boolean) {
    super();
  }

  override async getGeneration(credentialRef: string): Promise<number | undefined> {
    if (this.isLockHeld()) throw new Error('runtime state queried while credential lock is held');
    return super.getGeneration(credentialRef);
  }

  override async clear(credentialRef: string, generation?: number): Promise<void> {
    if (this.isLockHeld()) throw new Error('runtime state mutated while credential lock is held');
    return super.clear(credentialRef, generation);
  }
}

function jwt(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`;
}

function sharedHttpVaults() {
  const ref = {
    id: 'credential-shared', ownerId: 'global', kind: 'codex_subscription_oauth', metadata: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  let value = '';
  const oauthRefreshTokens: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) {
      const params = new URLSearchParams(String(init?.body));
      const refreshToken = params.get('refresh_token') ?? '';
      oauthRefreshTokens.push(refreshToken);
      return new Response(JSON.stringify({
        access_token: jwt('acct-primary'), refresh_token: `refreshed:${refreshToken}`, expires_in: 3600,
      }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.endsWith('/secrets')) value = String(body.value);
    if (url.endsWith('/rotate')) value = String(body.value);
    if (url.endsWith('/secrets/resolve')) {
      return new Response(JSON.stringify({ value, ref }), { status: 200 });
    }
    return new Response(JSON.stringify(ref), { status: 200 });
  }) as unknown as typeof fetch;
  const options = { baseUrl: 'https://vault.example.com', authToken: 'test-token', fetchImpl };
  return {
    vaultA: new HttpSecretVault(options), vaultB: new HttpSecretVault(options),
    oauthRefreshTokens, fetchImpl,
  };
}

describe('Codex credential concurrency', () => {
  it('credential lock 内不查询共享 runtime state，避免单连接 PG 池自锁', async () => {
    let lockHeld = false;
    const lock: CodexCredentialLock = {
      async runExclusive<T>(_key: string, fn: () => Promise<T>): Promise<T> {
        lockHeld = true;
        try {
          return await fn();
        } finally {
          lockHeld = false;
        }
      },
    };
    const runtimeStateStore = new LockAwareRuntimeStateStore(() => lockHeld);
    const config: CodexSubscriptionRuntimeConfig = { enabled: true };
    const manager = new CodexCredentialManager({
      vault: new InMemorySecretVault(),
      getConfig: () => config,
      runtimeStateStore,
      lock,
      fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 200 })) as unknown as typeof fetch,
    });
    const original = await manager.persistLogin({
      accessToken: jwt('acct-primary'), refreshToken: 'refresh-old', idToken: jwt('acct-primary'),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    config.credentialRef = original.credentialRef;

    const reauthorized = await manager.persistLogin({
      accessToken: jwt('acct-primary'), refreshToken: 'refresh-new', idToken: jwt('acct-primary'),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }, original.credentialRef);

    expect(reauthorized.bundle.generation).toBe(2);
    await expect(manager.getRuntimeGeneration(original.credentialRef)).resolves.toBe(2);
  });

  it('损坏或缺失的旧 Secret 可通过重授权修复，并单调推进 generation', async () => {
    const vault = new InMemorySecretVault();
    const runtimeStateStore = new InMemoryCodexCredentialRuntimeStateStore();
    const config: CodexSubscriptionRuntimeConfig = { enabled: true };
    const manager = new CodexCredentialManager({ vault, runtimeStateStore, getConfig: () => config });
    const malformed = await vault.putSecret(
      'global',
      'codex_subscription_oauth',
      '{malformed',
      systemCaller('write'),
    );
    await runtimeStateStore.markAuthUnavailable(malformed.id, 'credential_invalid', 4);

    const repaired = await manager.persistLogin({
      accessToken: jwt('acct-primary'), refreshToken: 'refresh-repaired', idToken: jwt('acct-primary'),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }, malformed.id);
    expect(repaired.credentialRef).toBe(malformed.id);
    expect(repaired.bundle.generation).toBe(5);

    const missingRef = 'credential-missing';
    await runtimeStateStore.markAuthUnavailable(missingRef, 'credential_not_found', 7);
    const replaced = await manager.persistLogin({
      accessToken: jwt('acct-primary'), refreshToken: 'refresh-replacement', idToken: jwt('acct-primary'),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }, missingRef);
    expect(replaced.credentialRef).not.toBe(missingRef);
    expect(replaced.bundle.generation).toBe(8);
    await expect(vault.getSecret(replaced.credentialRef, systemCaller('read'))).resolves.toContain(
      'refresh-replacement',
    );
  });

  it('新增账号的 runtime state 初始化失败时只撤销本地 Secret，保留会话 token 可重试', async () => {
    const vault = new InMemorySecretVault();
    const runtimeStateStore = new InMemoryCodexCredentialRuntimeStateStore();
    vi.spyOn(runtimeStateStore, 'clear').mockRejectedValueOnce(new Error('runtime state unavailable'));
    let createdRef: string | undefined;
    const putSecret = vault.putSecret.bind(vault);
    vi.spyOn(vault, 'putSecret').mockImplementation(async (...args) => {
      const ref = await putSecret(...args);
      createdRef = ref.id;
      return ref;
    });
    const revokeFetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const manager = new CodexCredentialManager({
      vault,
      runtimeStateStore,
      getConfig: () => ({ enabled: true }),
      fetchImpl: revokeFetch as unknown as typeof fetch,
    });

    await expect(manager.persistLogin({
      accessToken: jwt('acct-primary'), refreshToken: 'refresh-orphan', idToken: jwt('acct-primary'),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    })).rejects.toThrow('runtime state unavailable');

    expect(createdRef).toBeTruthy();
    await expect(vault.getSecret(createdRef!, systemCaller('read'))).rejects.toThrow(/secret revoked/);
    expect(revokeFetch).not.toHaveBeenCalled();
  });

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

  it('重授权读取旧 bundle 遇到瞬时错误时不创建替代凭据', async () => {
    const vault = new InMemorySecretVault();
    const putSecret = vi.spyOn(vault, 'putSecret');
    vi.spyOn(vault, 'getSecret').mockRejectedValueOnce(new Error('vault network unavailable'));
    const manager = new CodexCredentialManager({
      vault, getConfig: () => ({ enabled: true }),
    });
    await expect(manager.persistLogin({
      accessToken: jwt('acct-primary'), refreshToken: 'new-login-refresh',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }, 'existing-credential')).rejects.toThrow(/vault network unavailable/);
    expect(putSecret).not.toHaveBeenCalled();
  });

  it('共享锁内绕过 HttpSecretVault 缓存并推进 refresh generation fence', async () => {
    const { vaultA, vaultB, oauthRefreshTokens, fetchImpl } = sharedHttpVaults();
    const config: CodexSubscriptionRuntimeConfig = { enabled: true };
    const lock = new LocalCodexCredentialLock();
    const managerA = new CodexCredentialManager({ vault: vaultA, getConfig: () => config, lock, fetchImpl });
    const managerB = new CodexCredentialManager({ vault: vaultB, getConfig: () => config, lock, fetchImpl });
    const original = await managerA.persistLogin({
      accessToken: jwt('acct-primary'), refreshToken: 'refresh-old', idToken: jwt('acct-primary'),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    config.credentialRef = original.credentialRef;
    await managerA.getCredentials();

    const reauthorized = await managerB.persistLogin({
      accessToken: jwt('acct-primary'), refreshToken: 'new-login-refresh', idToken: jwt('acct-primary'),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    }, original.credentialRef);
    const refreshed = await managerA.getCredentials(true, original.bundle.generation, original.credentialRef);

    expect(reauthorized.bundle.generation).toBe(2);
    expect(oauthRefreshTokens).toEqual(['new-login-refresh']);
    expect(refreshed.refreshToken).toBe('refreshed:new-login-refresh');
    expect(refreshed.generation).toBe(3);
    expect(refreshed.accountId).toBe('acct-primary');
    await managerA.markQuotaCooldown(original.credentialRef, 'stale-quota', 1);
    await managerA.markAuthUnavailable(original.credentialRef, 'stale-auth', 1);
    await expect(managerA.getRuntimeState(original.credentialRef)).resolves.toBeUndefined();
  });
});
