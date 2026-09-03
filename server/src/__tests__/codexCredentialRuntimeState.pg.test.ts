import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InMemorySecretVault } from '../security/secretVault.js';
import {
  CodexCredentialManager,
  PgCodexCredentialLock,
  type CodexSubscriptionRuntimeConfig,
} from '../runtime/responses/codexCredentialManager.js';
import { PgCodexCredentialRuntimeStateStore } from '../runtime/responses/codexCredentialRuntimeState.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

function jwt(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`;
}

describePg('PgCodexCredentialRuntimeStateStore generation contract', () => {
  const prefix = `codex_state_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgCodexCredentialRuntimeStateStore;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: connectionString!,
      connectionTimeoutMillis: 500,
      max: 1,
    });
    store = new PgCodexCredentialRuntimeStateStore(pool, prefix);
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool || !store) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${store.table}`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('clear 只推进更高 generation，不覆盖同代或更旧代的故障', async () => {
    await store.markAuthUnavailable('credential-auth', 'invalid_grant', 2);
    await store.markQuotaCooldown(
      'credential-quota',
      '2099-09-02T12:10:00.000Z',
      'insufficient_quota',
      2,
    );

    await store.clear('credential-auth', 2);
    await store.clear('credential-quota', 2);
    await store.clear('credential-auth', 1);
    await store.clear('credential-quota', 1);

    await expect(store.get('credential-auth')).resolves.toMatchObject({
      availability: 'auth_unavailable',
      credentialGeneration: 2,
    });
    await expect(store.get('credential-quota')).resolves.toMatchObject({
      availability: 'quota_cooldown',
      credentialGeneration: 2,
    });

    await store.clear('credential-auth', 3);
    await store.clear('credential-quota', 3);
    await expect(store.getGeneration('credential-auth')).resolves.toBe(3);
    await expect(store.getGeneration('credential-quota')).resolves.toBe(3);
    await expect(store.get('credential-auth')).resolves.toBeUndefined();
    await expect(store.get('credential-quota')).resolves.toBeUndefined();
  });

  it('单连接共享池上的 credential lock 不会与 runtime state 查询互相等待', async () => {
    const config: CodexSubscriptionRuntimeConfig = { enabled: true };
    const manager = new CodexCredentialManager({
      vault: new InMemorySecretVault(),
      getConfig: () => config,
      lock: new PgCodexCredentialLock(pool),
      runtimeStateStore: store,
    });
    const original = await manager.persistLogin({
      accessToken: jwt('acct-single-pool'),
      refreshToken: 'refresh-single-pool',
      idToken: jwt('acct-single-pool'),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    config.credentialRefs = [original.credentialRef];

    const reauthorized = await manager.persistLogin({
      accessToken: jwt('acct-single-pool'),
      refreshToken: 'refresh-single-pool',
      idToken: jwt('acct-single-pool'),
      expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    }, original.credentialRef);

    expect(reauthorized.bundle.generation).toBe(2);
    await expect(store.getGeneration(original.credentialRef)).resolves.toBe(2);
  });
});
