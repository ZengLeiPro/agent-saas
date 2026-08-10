import { describe, expect, it, vi } from 'vitest';

import { InMemorySecretVault, type SecretRef, type SecretVault, type VaultCaller } from '../security/secretVault.js';
import type {
  FeishuConnectionIdentity,
  FeishuConnectionRecord,
  FeishuConnectionStore,
  FeishuLoginMetadata,
} from '../feishu/store.js';
import {
  deterministicFeishuSecretId,
  FeishuOAuthClient,
  FeishuOAuthError,
  FeishuTokenBroker,
  FeishuTokenBrokerLoginRunner,
} from '../feishu/tokenBroker.js';
import type { UserInfo } from '../data/users/types.js';

const NOW = new Date('2026-08-01T00:00:00.000Z');
const IDENTITY: FeishuConnectionIdentity = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  username: 'alice',
};
const TEST_VAULT_READER: VaultCaller = {
  actor: 'connector_proxy',
  userId: IDENTITY.userId,
  tenantId: IDENTITY.tenantId,
  scopes: ['secret:feishu_token_bundle:read'],
};
const USER: UserInfo = {
  id: IDENTITY.userId,
  tenantId: IDENTITY.tenantId,
  username: IDENTITY.username,
  role: 'user',
  createdAt: NOW.toISOString(),
  createdBy: 'system',
  updatedAt: NOW.toISOString(),
};

class ProcessCachingVault implements SecretVault {
  private readonly cache = new Map<string, string>();

  constructor(private readonly backend: SecretVault) {}

  putSecret(
    ownerId: string,
    kind: string,
    value: string,
    caller: VaultCaller,
    metadata?: Record<string, unknown>,
  ): Promise<SecretRef> {
    return this.backend.putSecret(ownerId, kind, value, caller, metadata);
  }

  async getSecret(ref: SecretRef | string, caller: VaultCaller): Promise<string> {
    const id = typeof ref === 'string' ? ref : ref.id;
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const value = await this.backend.getSecret(ref, caller);
    this.cache.set(id, value);
    return value;
  }

  async rotateSecret(ref: SecretRef | string, value: string, caller: VaultCaller): Promise<SecretRef> {
    const updated = await this.backend.rotateSecret(ref, value, caller);
    this.invalidate(ref);
    return updated;
  }

  async revokeSecret(ref: SecretRef | string, caller: VaultCaller): Promise<void> {
    await this.backend.revokeSecret(ref, caller);
    this.invalidate(ref);
  }

  invalidate(ref: SecretRef | string): void {
    this.cache.delete(typeof ref === 'string' ? ref : ref.id);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function oauth(fetchImpl: typeof fetch): FeishuOAuthClient {
  return new FeishuOAuthClient({ appId: 'cli_app', appSecret: 'server-only-secret', fetchImpl });
}

function mutableStore(): FeishuConnectionStore & { rows: FeishuConnectionRecord[] } {
  const store: FeishuConnectionStore & { rows: FeishuConnectionRecord[] } = {
    rows: [],
    upsertLogin: vi.fn(async (identity: FeishuConnectionIdentity, login: FeishuLoginMetadata, now = NOW) => {
      const record: FeishuConnectionRecord = {
        ...identity,
        ...login,
        connectionStatus: 'pending',
        authenticated: true,
        tokenStatus: 'valid',
        nextCheckAt: now.toISOString(),
        consecutiveFailures: 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      store.rows = [record];
    }),
    claimDue: vi.fn(async () => null),
    completeCheck: vi.fn(async () => undefined),
    failCheck: vi.fn(async () => undefined),
    releaseClaim: vi.fn(async () => undefined),
    listForUser: vi.fn(async (tenantId, userId) => store.rows.filter(row => row.tenantId === tenantId && row.userId === userId)),
    updateBrokerToken: vi.fn(async (_identity, _profileId, expiresAt, refreshExpiresAt, scope) => {
      store.rows = store.rows.map(row => ({ ...row, expiresAt, refreshExpiresAt, scope }));
    }),
    invalidateBroker: vi.fn(async (_identity, _profileId, reason) => {
      store.rows = store.rows.map(row => ({
        ...row,
        connectionStatus: 'disconnected',
        authenticated: false,
        lastError: reason,
      }));
    }),
    withBrokerRefreshLock: vi.fn(async (_identity, _profileId, run) => await run()),
    removeLegacyProfile: vi.fn(async (identity, profileId) => {
      const before = store.rows.length;
      store.rows = store.rows.filter(row => row.tenantId !== identity.tenantId
        || row.userId !== identity.userId
        || row.profileId !== profileId
        || row.tokenSecretRef
        || row.brokerSecretId);
      return before - store.rows.length;
    }),
    markBrokerProviderRevoked: vi.fn(async (_identity, profileId) => {
      store.rows = store.rows.map(row => row.profileId === profileId
        ? { ...row, connectionStatus: 'disconnected', authenticated: false, tokenStatus: 'provider_revoked' }
        : row);
    }),
    markBrokerRevoked: vi.fn(async (_identity, profileId) => {
      store.rows = store.rows.map(row => row.profileId === profileId
        ? { ...row, connectionStatus: 'disconnected', authenticated: false, tokenStatus: 'revoked' }
        : row);
    }),
    removeForUser: vi.fn(async (tenantId, userId) => {
      const before = store.rows.length;
      store.rows = store.rows.filter(row => row.tenantId !== tenantId || row.userId !== userId);
      return before - store.rows.length;
    }),
  };
  return store;
}

async function authorize(
  fetchImpl: typeof fetch,
  store = mutableStore(),
  vault: SecretVault = new InMemorySecretVault(),
): Promise<{ broker: FeishuTokenBroker; store: ReturnType<typeof mutableStore>; vault: SecretVault }> {
  const broker = new FeishuTokenBroker({
    oauth: oauth(fetchImpl),
    vault,
    connectionStore: store,
    scope: 'im:message docs:document',
    profileId: 'kaiyan-agent',
    now: () => NOW,
    wait: async () => undefined,
  });
  await broker.authorize(IDENTITY, () => undefined);
  return { broker, store, vault };
}

describe('Feishu OAuth wire protocol', () => {
  it('starts device authorization with Basic auth and forced offline_access', async () => {
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${Buffer.from('cli_app:server-only-secret').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      });
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('client_id')).toBe('cli_app');
      expect(body.get('scope')?.split(' ')).toEqual(expect.arrayContaining([
        'offline_access',
        'docs:document:readonly',
      ]));
      return jsonResponse({
        device_code: 'device-1',
        user_code: 'ABCD',
        verification_uri: 'https://accounts.feishu.cn/device',
        expires_in: 240,
        interval: 5,
      });
    });

    await expect(oauth(fetchImpl).startDeviceAuthorization('docs:document:readonly')).resolves.toMatchObject({
      deviceCode: 'device-1',
      userCode: 'ABCD',
      verificationUriComplete: 'https://accounts.feishu.cn/device?user_code=ABCD',
    });
  });

  it.each([
    [{ error: 'authorization_pending' }, { status: 'pending' }],
    [{ error: 'slow_down' }, { status: 'slow_down' }],
    [{ error: 'access_denied', error_description: 'Denied' }, { status: 'denied', error: 'Denied' }],
    [{ error: 'expired_token', error_description: 'Expired' }, { status: 'expired', error: 'Expired' }],
    [{
      access_token: 'uat-1',
      refresh_token: 'rt-1',
      expires_in: 7200,
      refresh_token_expires_in: 604800,
      scope: 'im:message docs:document offline_access',
      token_type: 'Bearer',
    }, { status: 'success', token: expect.objectContaining({ accessToken: 'uat-1', refreshToken: 'rt-1' }) }],
  ])('maps device poll response %#', async (responseBody, expected) => {
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
      expect(body.get('client_secret')).toBe('server-only-secret');
      return jsonResponse(responseBody);
    });
    await expect(oauth(fetchImpl).exchangeDeviceCode('device-1')).resolves.toMatchObject(expected);
  });
});

describe('Feishu Token Broker', () => {
  it('polls pending then persists deterministic tenant/user-scoped Vault bundle', async () => {
    let poll = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-1', user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) {
        poll += 1;
        if (poll === 1) return jsonResponse({ error: 'authorization_pending' });
        return jsonResponse({
          access_token: 'uat-1', refresh_token: 'rt-1', expires_in: 7200,
          refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
        });
      }
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice', name: 'Alice' } });
    });
    const published = vi.fn();
    const { store, vault } = await authorize(fetchImpl, undefined, undefined);
    const row = store.rows[0]!;
    expect(poll).toBe(2);
    expect(row.tokenSecretRef).toBeTruthy();
    expect(row.brokerSecretId).toBe(deterministicFeishuSecretId(IDENTITY));
    await expect(vault.getSecret(row.tokenSecretRef!, {
      actor: 'connector_proxy', userId: 'bob', tenantId: IDENTITY.tenantId,
      scopes: ['secret:feishu_token_bundle:read'],
    })).rejects.toThrow('access denied');
    const bundle = JSON.parse(await vault.getSecret(row.tokenSecretRef!, TEST_VAULT_READER)) as Record<string, unknown>;
    expect(bundle).toMatchObject({
      secretId: deterministicFeishuSecretId(IDENTITY),
      connector: 'feishu',
      tenantId: IDENTITY.tenantId,
      userId: IDENTITY.userId,
      username: IDENTITY.username,
      accessToken: 'uat-1',
      refreshToken: 'rt-1',
      tokenType: 'Bearer',
      user: { openId: 'ou-alice', name: 'Alice' },
    });
    expect(JSON.stringify(bundle)).not.toContain('server-only-secret');
    expect(published).not.toHaveBeenCalled();
  });

  it('single-flights refreshes within five minutes', async () => {
    let refreshCalls = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-1', user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) {
        const body = new URLSearchParams(String(init?.body));
        if (body.get('grant_type') === 'refresh_token') {
          refreshCalls += 1;
          await Promise.resolve();
          return jsonResponse({
            access_token: 'uat-fresh', refresh_token: 'rt-fresh', expires_in: 7200,
            refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
          });
        }
        return jsonResponse({
          access_token: 'uat-short', refresh_token: 'rt-old', expires_in: 60,
          refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
        });
      }
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice', name: 'Alice' } });
    });
    const { broker } = await authorize(fetchImpl);

    const [first, second] = await Promise.all([
      broker.ensureFresh(IDENTITY),
      broker.ensureFresh(IDENTITY),
    ]);
    expect(refreshCalls).toBe(1);
    expect(first.accessToken).toBe('uat-fresh');
    expect(second.accessToken).toBe('uat-fresh');
  });

  it('invalid_grant disconnects the connection and revokes the local secret', async () => {
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-1', user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) {
        const body = new URLSearchParams(String(init?.body));
        if (body.get('grant_type') === 'refresh_token') return jsonResponse({ error: 'invalid_grant', error_description: 'expired' });
        return jsonResponse({
          access_token: 'uat-short', refresh_token: 'rt-old', expires_in: 60,
          refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
        });
      }
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice' } });
    });
    const { broker, store, vault } = await authorize(fetchImpl);
    const ref = store.rows[0]!.tokenSecretRef!;

    await expect(broker.ensureFresh(IDENTITY)).rejects.toMatchObject({ code: 'invalid_grant' } satisfies Partial<FeishuOAuthError>);
    expect(store.invalidateBroker).toHaveBeenCalledWith(IDENTITY, 'kaiyan-agent', 'invalid_grant');
    expect(store.rows[0]?.connectionStatus).toBe('disconnected');
    await expect(vault.getSecret(ref, TEST_VAULT_READER)).rejects.toThrow('revoked');
  });

  it('revokes provider token and Vault secret, leaving row deletion to auth service', async () => {
    let revokeBody = '';
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-1', user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) return jsonResponse({
        access_token: 'uat-1', refresh_token: 'rt-1', expires_in: 7200,
        refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
      });
      if (url.includes('/revoke')) {
        revokeBody = String(init?.body);
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice' } });
    });
    const { broker, store, vault } = await authorize(fetchImpl);
    const ref = store.rows[0]!.tokenSecretRef!;

    await broker.revokeUser(IDENTITY);
    expect(new URLSearchParams(revokeBody).get('token')).toBe('rt-1');
    expect(new URLSearchParams(revokeBody).get('token_type_hint')).toBe('refresh_token');
    expect(store.removeForUser).not.toHaveBeenCalled();
    await expect(vault.getSecret(ref, TEST_VAULT_READER)).rejects.toThrow('revoked');
  });

  it('provider revoke 失败时保留 Vault secret 与连接引用', async () => {
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-1', user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) return jsonResponse({
        access_token: 'uat-1', refresh_token: 'rt-1', expires_in: 7200,
        refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
      });
      if (url.includes('/revoke')) return jsonResponse({ error: 'temporarily_unavailable' }, 503);
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice' } });
    });
    const { broker, store, vault } = await authorize(fetchImpl);
    const ref = store.rows[0]!.tokenSecretRef!;

    await expect(broker.revokeUser(IDENTITY)).rejects.toBeInstanceOf(Error);
    await expect(vault.getSecret(ref, TEST_VAULT_READER)).resolves.toContain('rt-1');
    expect(store.removeForUser).not.toHaveBeenCalled();
    expect(store.rows[0]?.tokenSecretRef).toBe(ref);
  });

  it('跨进程 advisory lock 等待超时时 fail closed，不重复消费 refresh token', async () => {
    let refreshCalls = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-1', user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) {
        const body = new URLSearchParams(String(init?.body));
        if (body.get('grant_type') === 'refresh_token') refreshCalls += 1;
        return jsonResponse({
          access_token: 'uat-short', refresh_token: 'rt-old', expires_in: 60,
          refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
        });
      }
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice' } });
    });
    const { broker, store } = await authorize(fetchImpl);
    store.withBrokerRefreshLock = vi.fn(async () => {
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    });

    await expect(broker.ensureFresh(IDENTITY)).rejects.toMatchObject({
      code: 'refresh_in_progress',
      retryable: true,
    } satisfies Partial<FeishuOAuthError>);
    expect(refreshCalls).toBe(0);
  });

  it('provider 已轮换 token 后，即使 DB metadata 更新失败仍以 Vault 新 bundle 为准', async () => {
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-1', user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) {
        const body = new URLSearchParams(String(init?.body));
        return body.get('grant_type') === 'refresh_token'
          ? jsonResponse({
              access_token: 'uat-fresh', refresh_token: 'rt-rotated', expires_in: 7200,
              refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
            })
          : jsonResponse({
              access_token: 'uat-short', refresh_token: 'rt-old', expires_in: 60,
              refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
            });
      }
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice' } });
    });
    const { broker, store, vault } = await authorize(fetchImpl);
    store.updateBrokerToken = vi.fn(async () => { throw new Error('pg down'); });

    await expect(broker.ensureFresh(IDENTITY)).resolves.toMatchObject({
      accessToken: 'uat-fresh',
      refreshToken: 'rt-rotated',
    });
    const plaintext = await vault.getSecret(store.rows[0]!.tokenSecretRef!, TEST_VAULT_READER);
    expect(JSON.parse(plaintext)).toMatchObject({ accessToken: 'uat-fresh', refreshToken: 'rt-rotated' });
  });

  it('live verify 同时绑定 open_id、union_id 与 tenant_key', async () => {
    let userInfoCalls = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-1', user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) return jsonResponse({
        access_token: 'uat-1', refresh_token: 'rt-1', expires_in: 7200,
        refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
      });
      userInfoCalls += 1;
      return jsonResponse({
        code: 0,
        data: {
          open_id: 'ou-alice',
          union_id: 'on-alice',
          tenant_key: userInfoCalls === 1 ? 'tenant-feishu-a' : 'tenant-feishu-b',
        },
      });
    });
    const { broker } = await authorize(fetchImpl);

    await expect(broker.verify(IDENTITY)).rejects.toThrow('tenant identity mismatch');
  });

  it('已连接身份不允许静默切换为另一飞书账号，并撤销新颁发 token', async () => {
    let authorizationRound = 0;
    let revokeToken = '';
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('device_authorization')) {
        authorizationRound += 1;
        return jsonResponse({
          device_code: `device-${authorizationRound}`, user_code: 'ABCD',
          verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
        });
      }
      if (url.includes('/oauth/token')) return jsonResponse({
        access_token: `uat-${authorizationRound}`, refresh_token: `rt-${authorizationRound}`, expires_in: 7200,
        refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
      });
      if (url.includes('/revoke')) {
        revokeToken = new URLSearchParams(String(init?.body)).get('token') ?? '';
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ code: 0, data: { open_id: authorizationRound === 1 ? 'ou-alice' : 'ou-bob' } });
    });
    const store = mutableStore();
    const vault = new InMemorySecretVault();
    const { broker } = await authorize(fetchImpl, store, vault);

    await expect(broker.authorize(IDENTITY, () => undefined)).rejects.toMatchObject({
      code: 'identity_mismatch',
    } satisfies Partial<FeishuOAuthError>);
    expect(store.rows[0]?.userOpenId).toBe('ou-alice');
    expect(revokeToken).toBe('rt-2');
  });

  it('跨进程命中旧 Vault cache 时，取得 lease 后强制 fresh read，不重复 refresh', async () => {
    let refreshCalls = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-1', user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) {
        const body = new URLSearchParams(String(init?.body));
        if (body.get('grant_type') === 'refresh_token') {
          refreshCalls += 1;
          return jsonResponse({
            access_token: 'uat-fresh', refresh_token: 'rt-rotated', expires_in: 7200,
            refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
          });
        }
        return jsonResponse({
          access_token: 'uat-short', refresh_token: 'rt-old', expires_in: 60,
          refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
        });
      }
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice' } });
    });
    const backend = new InMemorySecretVault();
    const vaultA = new ProcessCachingVault(backend);
    const vaultB = new ProcessCachingVault(backend);
    const store = mutableStore();
    const { broker: brokerA } = await authorize(fetchImpl, store, vaultA);
    const ref = store.rows[0]!.tokenSecretRef!;
    await vaultB.getSecret(ref, TEST_VAULT_READER);

    await brokerA.ensureFresh(IDENTITY);
    const brokerB = new FeishuTokenBroker({
      oauth: oauth(fetchImpl),
      vault: vaultB,
      connectionStore: store,
      scope: 'im:message docs:document',
      profileId: 'kaiyan-agent',
      now: () => NOW,
      wait: async () => undefined,
    });
    await expect(brokerB.ensureFresh(IDENTITY)).resolves.toMatchObject({ accessToken: 'uat-fresh' });
    expect(refreshCalls).toBe(1);
  });

  it('provider refresh 成功但 Vault rotate 连续失败时，补偿撤销新 token 并 fail closed', async () => {
    let failRotate = false;
    let revokedToken = '';
    const backend = new InMemorySecretVault();
    const vault: SecretVault = {
      putSecret: (...args) => backend.putSecret(...args),
      getSecret: (...args) => backend.getSecret(...args),
      rotateSecret: async (...args) => {
        if (failRotate) throw new Error('vault write failed');
        return await backend.rotateSecret(...args);
      },
      revokeSecret: (...args) => backend.revokeSecret(...args),
    };
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-1', user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) {
        const body = new URLSearchParams(String(init?.body));
        return body.get('grant_type') === 'refresh_token'
          ? jsonResponse({
              access_token: 'uat-fresh', refresh_token: 'rt-rotated', expires_in: 7200,
              refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
            })
          : jsonResponse({
              access_token: 'uat-short', refresh_token: 'rt-old', expires_in: 60,
              refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
            });
      }
      if (url.includes('/revoke')) {
        revokedToken = new URLSearchParams(String(init?.body)).get('token') ?? '';
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice' } });
    });
    const store = mutableStore();
    const { broker } = await authorize(fetchImpl, store, vault);
    failRotate = true;

    await expect(broker.ensureFresh(IDENTITY)).rejects.toMatchObject({
      code: 'token_persistence_failed',
    } satisfies Partial<FeishuOAuthError>);
    expect(revokedToken).toBe('rt-rotated');
    expect(store.rows[0]).toMatchObject({ connectionStatus: 'disconnected', authenticated: false });
  });

  it('旧 CLI keychain 连接在删 PG 前先调用 legacy logout', async () => {
    const store = mutableStore();
    store.rows = [{
      ...IDENTITY,
      profileId: 'legacy-profile',
      appId: 'cli_app',
      userOpenId: 'ou-alice',
      connectionStatus: 'connected',
      authenticated: true,
      nextCheckAt: NOW.toISOString(),
      consecutiveFailures: 0,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }];
    const broker = new FeishuTokenBroker({
      oauth: oauth(vi.fn(async () => { throw new Error('provider should not be called'); })),
      vault: new InMemorySecretVault(),
      connectionStore: store,
      scope: 'im:message',
      profileId: 'kaiyan-agent',
      now: () => NOW,
      wait: async () => undefined,
    });
    const legacyLogout = vi.fn(async () => undefined);
    const runner = new FeishuTokenBrokerLoginRunner(broker, { legacyLogout });

    await runner.logout(USER, ['legacy-profile']);
    expect(legacyLogout).toHaveBeenCalledWith(USER, ['legacy-profile']);
    expect(store.removeForUser).not.toHaveBeenCalled();
  });

  it('旧 CLI profile 升级到 Broker 前先 logout keychain 并删除旧行', async () => {
    const store = mutableStore();
    store.rows = [{
      ...IDENTITY,
      profileId: 'kaiyan-agent',
      appId: 'cli_app',
      userOpenId: 'ou-legacy',
      connectionStatus: 'connected',
      authenticated: true,
      nextCheckAt: NOW.toISOString(),
      consecutiveFailures: 0,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }];
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-1', user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) return jsonResponse({
        access_token: 'uat-1', refresh_token: 'rt-1', expires_in: 7200,
        refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
      });
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice' } });
    });
    const broker = new FeishuTokenBroker({
      oauth: oauth(fetchImpl), vault: new InMemorySecretVault(), connectionStore: store,
      scope: 'im:message docs:document', profileId: 'kaiyan-agent', now: () => NOW, wait: async () => undefined,
    });
    const legacyLogout = vi.fn(async () => undefined);
    const runner = new FeishuTokenBrokerLoginRunner(broker, { legacyLogout });

    await runner.login(USER, () => undefined);
    expect(legacyLogout).toHaveBeenCalledWith(USER, ['kaiyan-agent']);
    expect(store.removeLegacyProfile).toHaveBeenCalledWith(IDENTITY, 'kaiyan-agent');
    expect(store.rows[0]).toMatchObject({ userOpenId: 'ou-alice', tokenStatus: 'valid' });
    expect(store.rows[0]?.tokenSecretRef).toBeTruthy();
  });

  it('refresh 响应缩减业务 scope 时撤销新 token 并要求重新授权', async () => {
    let revokedToken = '';
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-1', user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) {
        const body = new URLSearchParams(String(init?.body));
        return body.get('grant_type') === 'refresh_token'
          ? jsonResponse({
              access_token: 'uat-reduced', refresh_token: 'rt-reduced', expires_in: 7200,
              refresh_token_expires_in: 604800, scope: 'im:message offline_access', token_type: 'Bearer',
            })
          : jsonResponse({
              access_token: 'uat-short', refresh_token: 'rt-old', expires_in: 60,
              refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
            });
      }
      if (url.includes('/revoke')) {
        revokedToken = new URLSearchParams(String(init?.body)).get('token') ?? '';
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice' } });
    });
    const { broker, store } = await authorize(fetchImpl);

    await expect(broker.ensureFresh(IDENTITY)).rejects.toMatchObject({ code: 'insufficient_grant' });
    expect(revokedToken).toBe('rt-reduced');
    expect(store.rows[0]).toMatchObject({ connectionStatus: 'disconnected', authenticated: false });
  });

  it('Vault 已撤销但最终 PG 更新失败时，从 provider_revoked 状态幂等重试', async () => {
    let providerRevokeCalls = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-1', user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) return jsonResponse({
        access_token: 'uat-1', refresh_token: 'rt-1', expires_in: 7200,
        refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
      });
      if (url.includes('/revoke')) {
        providerRevokeCalls += 1;
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice' } });
    });
    const { broker, store } = await authorize(fetchImpl);
    const markRevoked = store.markBrokerRevoked!;
    store.markBrokerRevoked = vi.fn()
      .mockRejectedValueOnce(new Error('pg down'))
      .mockImplementation(markRevoked);

    await expect(broker.revokeUser(IDENTITY)).rejects.toThrow('pg down');
    expect(store.rows[0]?.tokenStatus).toBe('provider_revoked');
    await expect(broker.revokeUser(IDENTITY)).resolves.toBeUndefined();
    expect(providerRevokeCalls).toBe(1);
    expect(store.rows[0]?.tokenStatus).toBe('revoked');
  });

  it('App ID 变化时不覆盖旧 Broker ref，并补偿撤销新 token', async () => {
    let revokedToken = '';
    const firstFetch: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-1', user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) return jsonResponse({
        access_token: 'uat-old', refresh_token: 'rt-old', expires_in: 7200,
        refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
      });
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice' } });
    });
    const { store, vault } = await authorize(firstFetch);
    const oldRef = store.rows[0]!.tokenSecretRef!;
    const secondFetch: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-2', user_code: 'EFGH', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) return jsonResponse({
        access_token: 'uat-new', refresh_token: 'rt-new', expires_in: 7200,
        refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
      });
      if (url.includes('/revoke')) {
        revokedToken = new URLSearchParams(String(init?.body)).get('token') ?? '';
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice' } });
    });
    const broker = new FeishuTokenBroker({
      oauth: new FeishuOAuthClient({ appId: 'cli_new', appSecret: 'new-secret', fetchImpl: secondFetch }),
      vault, connectionStore: store, scope: 'im:message docs:document', profileId: 'kaiyan-agent',
      now: () => NOW, wait: async () => undefined,
    });

    await expect(broker.authorize(IDENTITY, () => undefined)).rejects.toMatchObject({ code: 'app_mismatch' });
    expect(revokedToken).toBe('rt-new');
    expect(store.rows[0]).toMatchObject({ appId: 'cli_app', tokenSecretRef: oldRef });
    await expect(vault.getSecret(oldRef, TEST_VAULT_READER)).resolves.toContain('rt-old');
  });

  it('已有连接重新授权时 PG 写失败不会把 Vault 替换成随后撤销的新 token', async () => {
    let tokenCalls = 0;
    let revokedToken = '';
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: `device-${tokenCalls + 1}`, user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) {
        tokenCalls += 1;
        return jsonResponse({
          access_token: `uat-${tokenCalls}`, refresh_token: `rt-${tokenCalls}`, expires_in: 7200,
          refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
        });
      }
      if (url.includes('/revoke')) {
        revokedToken = new URLSearchParams(String(init?.body)).get('token') ?? '';
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice' } });
    });
    const { broker, store, vault } = await authorize(fetchImpl);
    const ref = store.rows[0]!.tokenSecretRef!;
    store.upsertLogin = vi.fn(async () => { throw new Error('pg down'); });

    await expect(broker.authorize(IDENTITY, () => undefined)).rejects.toThrow('pg down');
    expect(revokedToken).toBe('rt-2');
    await expect(vault.getSecret(ref, TEST_VAULT_READER)).resolves.toContain('rt-1');
  });

  it('新连接写入 PG 失败时回收刚创建的 Vault secret', async () => {
    let revokedProviderToken = '';
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('device_authorization')) return jsonResponse({
        device_code: 'device-1', user_code: 'ABCD', verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240, interval: 1,
      });
      if (url.includes('/oauth/token')) return jsonResponse({
        access_token: 'uat-1', refresh_token: 'rt-1', expires_in: 7200,
        refresh_token_expires_in: 604800, scope: 'im:message docs:document offline_access', token_type: 'Bearer',
      });
      if (url.includes('/revoke')) {
        revokedProviderToken = new URLSearchParams(String(init?.body)).get('token') ?? '';
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ code: 0, data: { open_id: 'ou-alice' } });
    });
    const store = mutableStore();
    store.upsertLogin = vi.fn(async () => { throw new Error('pg down'); });
    const vault = new InMemorySecretVault();
    const revokeSecret = vi.spyOn(vault, 'revokeSecret');
    const broker = new FeishuTokenBroker({
      oauth: oauth(fetchImpl), vault, connectionStore: store,
      scope: 'im:message docs:document', profileId: 'kaiyan-agent', now: () => NOW, wait: async () => undefined,
    });

    await expect(broker.authorize(IDENTITY, () => undefined)).rejects.toThrow('pg down');
    expect(revokedProviderToken).toBe('rt-1');
    expect(revokeSecret).toHaveBeenCalledOnce();
    const ref = revokeSecret.mock.calls[0]?.[0] as string;
    await expect(vault.getSecret(ref, TEST_VAULT_READER)).rejects.toThrow('revoked');
  });
});
