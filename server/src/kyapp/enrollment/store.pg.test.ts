import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgKyAppSystemStore } from '../systems/store.js';
import { PgReplayReservationStore } from '../workload/replayStore.js';
import { PgEnrollmentStore } from './store.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('KY App V2 enrollment PostgreSQL 原子性', () => {
  const prefix = `kyv2_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const keyId = 'A'.repeat(43);
  let pool: InstanceType<typeof Pool>;
  let systems: PgKyAppSystemStore;
  let operations: PgEnrollmentStore;
  let replays: PgReplayReservationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 8 });
    systems = new PgKyAppSystemStore({ pool, tablePrefix: prefix });
    operations = new PgEnrollmentStore({ pool, tablePrefix: prefix });
    replays = new PgReplayReservationStore({ pool, tablePrefix: prefix });
    await systems.init();
    const registered = await systems.registerVersion({
      systemId: 'demo-erp',
      name: '演示 ERP',
      manifest: { contractVersion: 2, systemId: 'demo-erp' },
      actor: 'platform-admin',
    });
    await systems.publishVersion({
      systemId: 'demo-erp',
      digest: registered.version.digest,
      expectedVersion: registered.definition.version,
      actor: 'platform-admin',
    });
    await systems.createInstallation({
      installationId: 'install-v2-demo',
      tenantId: 'tenant-a',
      systemId: 'demo-erp',
      baseUrl: 'https://erp.example.com',
      origin: 'https://erp.example.com',
      techContactUserId: 'admin-a',
      actor: 'admin-a',
    });
    await systems.markDomainVerified('install-v2-demo', 'admin-a');
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      const tables = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE $1`,
        [`${prefix}%`],
      );
      for (const { tablename } of tables.rows) {
        await pool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
      }
    } finally {
      await pool.end();
    }
  });

  it('同一 operation 并发创建幂等，变更请求被拒绝', async () => {
    const request = {
      operationId: 'op-concurrent',
      installationId: 'install-v2-demo',
      actorUserId: 'admin-a',
      requestDigest: '1'.repeat(64),
    };
    const results = await Promise.all([
      operations.createOrGet(request),
      operations.createOrGet(request),
    ]);
    expect(results.filter((item) => item.created)).toHaveLength(1);
    await expect(
      operations.createOrGet({ ...request, requestDigest: '2'.repeat(64) }),
    ).rejects.toMatchObject({ reason: 'operation_conflict' });
  });

  it('授权码并发兑换只提交一次，并原子绑定部署公钥与安装身份', async () => {
    const operationId = 'op-exchange';
    await operations.createOrGet({
      operationId,
      installationId: 'install-v2-demo',
      actorUserId: 'admin-a',
      requestDigest: '3'.repeat(64),
    });
    await operations.recordChallenge(operationId, {
      deploymentId: 'dep-demo-01',
      keyId,
      publicJwk: { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) },
      origin: 'https://erp.example.com',
      callbackUrl: 'https://erp.example.com/ky/enroll/callback',
      callbackState: 's'.repeat(32),
      pkceChallenge: 'p'.repeat(43),
      scopes: ['installation.activate', 'workload.token.issue'],
    });
    const codeSha256 = '4'.repeat(64);
    await operations.issueCode({
      operationId,
      actorUserId: 'admin-a',
      codeSha256,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const exchange = {
      codeSha256,
      now: new Date(),
      deploymentId: 'dep-demo-01',
      keyId,
      grantJti: 'grant-1',
      result: { assertionJti: 'assert-1', dpopJti: 'dpop-1' },
    };
    const committed = await Promise.all([
      operations.commitExchange(exchange),
      operations.commitExchange(exchange),
    ]);
    expect(committed.filter((item) => !item.alreadyCommitted)).toHaveLength(1);
    const installation = await systems.getInstallation('install-v2-demo');
    expect(installation).toMatchObject({
      authMode: 'v2_asymmetric',
      deploymentId: 'dep-demo-01',
      currentKeyId: keyId,
      identityGeneration: 1,
    });
    const keys = await pool.query(
      `SELECT key_id,status,generation FROM ${operations.keysTable} WHERE installation_id=$1`,
      ['install-v2-demo'],
    );
    expect(keys.rows).toEqual([{ key_id: keyId, status: 'current', generation: '1' }]);
  });

  it('assertion 与 DPoP 的成对预占要么全成功、要么全部回滚', async () => {
    const proofs = [
      {
        keyId,
        jti: 'assertion-shared',
        kind: 'client_assertion' as const,
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        keyId,
        jti: 'dpop-shared',
        kind: 'dpop' as const,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    const results = await Promise.all([replays.reserveMany(proofs), replays.reserveMany(proofs)]);
    expect(results).toContain('reserved');
    expect(results.some((value) => value.endsWith('_replayed'))).toBe(true);
    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${replays.table} WHERE key_id=$1`,
      [keyId],
    );
    expect(count.rows[0]?.count).toBe('2');
  });

  it('数据库结构不提供授权码明文、token 或私钥字段', async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name IN ($1,$2,$3)`,
      [operations.operationsTable, operations.keysTable, replays.table],
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toContain('code_sha256');
    expect(names).not.toEqual(
      expect.arrayContaining(['code', 'access_token', 'private_jwk', 'private_key']),
    );
  });
});
