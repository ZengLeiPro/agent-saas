import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgExternalClientStore } from './store.js';

const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;
const { Pool } = pg;

describePg('External Agent API Client PostgreSQL contract', () => {
  const prefix = `external_client_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgExternalClientStore;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: connectionString!,
      connectionTimeoutMillis: 5_000,
      max: 4,
    });
    store = new PgExternalClientStore(pool, { tablePrefix: prefix });
    await Promise.all([store.init(), store.init()]);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS ${store.table}`);
    await pool.end();
  });

  it('持久化创建、查询、轮换、撤销和最后使用时间', async () => {
    const created = await store.create({
      tenantId: 'tenant-a',
      serviceAccountUserId: 'service-account-a',
      name: 'ERP 集成',
      keyHash: 'hash-a',
      keyPrefix: 'ky_ext_test_a',
      scopes: ['conversations:write', 'executions:read'],
      allowedConnectionIds: ['readonly-db'],
      actorUserId: 'admin-a',
    });
    expect(await store.get(created.clientId)).toMatchObject({
      tenantId: 'tenant-a',
      keyHash: 'hash-a',
      allowedConnectionIds: ['readonly-db'],
    });
    expect(await store.findByKeyHash('hash-a')).toMatchObject({ clientId: created.clientId });

    const rotated = await store.rotateKey({
      clientId: created.clientId,
      keyHash: 'hash-b',
      keyPrefix: 'ky_ext_test_b',
      actorUserId: 'admin-b',
    });
    expect(rotated).toMatchObject({ keyHash: 'hash-b', updatedBy: 'admin-b' });
    expect(await store.findByKeyHash('hash-a')).toBeUndefined();

    const usedAt = new Date().toISOString();
    await store.touchLastUsed(created.clientId, usedAt);
    expect(await store.get(created.clientId)).toMatchObject({ lastUsedAt: usedAt });

    const revoked = await store.revoke({ clientId: created.clientId, actorUserId: 'admin-c' });
    expect(revoked).toMatchObject({ status: 'revoked', revokedBy: 'admin-c' });
    await expect(
      store.rotateKey({
        clientId: created.clientId,
        keyHash: 'hash-c',
        keyPrefix: 'ky_ext_test_c',
        actorUserId: 'admin-c',
      }),
    ).resolves.toBeUndefined();
  });

  it('创建完整约束和查询索引', async () => {
    const result = await pool.query<{
      primary_key: boolean;
      key_unique: boolean;
      index_count: number;
    }>(
      `SELECT
        EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=$1::regclass AND contype='p') AS primary_key,
        EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=$1::regclass AND contype='u') AS key_unique,
        (SELECT count(*)::int FROM pg_index WHERE indrelid=$1::regclass AND NOT indisunique) AS index_count`,
      [store.table],
    );
    expect(result.rows[0]).toEqual({ primary_key: true, key_unique: true, index_count: 2 });
  });
});
