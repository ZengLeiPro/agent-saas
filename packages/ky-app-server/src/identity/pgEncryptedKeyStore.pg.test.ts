import { createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PgEncryptedEphemeralSecretStore, PgEnrollmentAttemptStore } from '../enrollment/pg.js';
import { ensureKyAppSchema } from '../pg/schema.js';
import { PgEncryptedDeploymentKeyStore } from './pgEncryptedKeyStore.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = typeof databaseUrl === 'string' && databaseUrl !== '';
if (!enabled) console.warn('[ky-app-server] 跳过 V2 加密 PG 身份用例：未设置 TEST_DATABASE_URL');

describe.skipIf(!enabled)('V2 加密 PG 身份与恢复存储', () => {
  let pool: pg.Pool;
  const encryptionKey = randomBytes(32);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    await ensureKyAppSchema(pool);
  });
  afterAll(async () => pool?.end());
  beforeEach(async () => {
    await pool.query('DELETE FROM ky_app_enrollment_secrets');
    await pool.query('DELETE FROM ky_app_enrollment_attempts');
    await pool.query('DELETE FROM ky_app_deployment_key_refs');
  });

  it('两个副本首次启动只产生一个 deploymentId，私钥密文可跨副本签名', async () => {
    const first = new PgEncryptedDeploymentKeyStore(pool, encryptionKey);
    const second = new PgEncryptedDeploymentKeyStore(pool, encryptionKey);
    const [a, b] = await Promise.all([first.current(), second.current()]);
    expect(b).toEqual(a);
    const payload = Buffer.from('signed-by-shared-deployment-key');
    const signature = await second.sign(a.keyRef, payload);
    expect(
      verify(
        'sha256',
        payload,
        {
          key: createPublicKey({ key: a.publicJwk as JsonWebKey, format: 'jwk' }),
          dsaEncoding: 'ieee-p1363',
        },
        signature,
      ),
    ).toBe(true);
    const stored = await pool.query<{
      encrypted_private_key: string;
      public_jwk_json: Record<string, unknown>;
    }>('SELECT encrypted_private_key,public_jwk_json FROM ky_app_deployment_key_refs');
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].encrypted_private_key.split('.')).toHaveLength(3);
    expect(stored.rows[0].public_jwk_json).not.toHaveProperty('d');
  });

  it('两个副本并发准备轮换时复用同一把 next key', async () => {
    const first = new PgEncryptedDeploymentKeyStore(pool, encryptionKey);
    const second = new PgEncryptedDeploymentKeyStore(pool, encryptionKey);
    await first.current();
    const [a, b] = await Promise.all([first.prepareRotation(), second.prepareRotation()]);
    expect(b).toEqual(a);
    const rows = await pool.query(
      `SELECT key_id FROM ky_app_deployment_key_refs WHERE status='next'`,
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('接入进度与 verifier 密文可由另一个进程继续读取', async () => {
    const secretsA = new PgEncryptedEphemeralSecretStore(pool, encryptionKey);
    const secretsB = new PgEncryptedEphemeralSecretStore(pool, encryptionKey);
    const expiresAt = Date.now() + 60_000;
    const ref = await secretsA.put(
      JSON.stringify({ verifier: 'secret', state: 'state' }),
      expiresAt,
    );
    const attemptsA = new PgEnrollmentAttemptStore(pool);
    const created = await attemptsA.create({
      operationId: 'op-pg-recovery',
      installationId: 'iid-pg-recovery',
      tenantId: 'tenant-pg',
      systemId: 'system-pg',
      stateHash: 'a'.repeat(64),
      verifierRef: ref,
      keyId: 'k'.repeat(43),
      deploymentId: 'deployment-pg',
      publicJwk: { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) },
      status: 'pending',
      expiresAt,
    });
    expect(created.status).toBe('pending');
    expect(
      await new PgEnrollmentAttemptStore(pool).beginExchange(created.operationId, Date.now()),
    ).toBe(true);
    expect(await secretsB.get(ref)).toBe(JSON.stringify({ verifier: 'secret', state: 'state' }));
  });
});
