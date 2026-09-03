import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgCodexCredentialRuntimeStateStore } from '../runtime/responses/codexCredentialRuntimeState.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('PgCodexCredentialRuntimeStateStore generation contract', () => {
  const prefix = `codex_state_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgCodexCredentialRuntimeStateStore;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: connectionString!,
      connectionTimeoutMillis: 5_000,
      max: 2,
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
});
