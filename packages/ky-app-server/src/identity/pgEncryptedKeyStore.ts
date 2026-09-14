import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

import { p256JwkThumbprint, type P256PublicJwk } from '@kaiyan/ky-app-contract';
import type { Pool, PoolClient } from 'pg';

import { decryptValue, encryptValue } from './encryptedValue.js';
import type { DeploymentKeyStore } from './types.js';

interface KeyRow {
  deployment_id: string;
  key_id: string;
  key_ref: string;
  public_jwk_json: P256PublicJwk;
  encrypted_private_key: string;
  status: 'current' | 'next' | 'previous' | 'revoked';
  generation: string;
}

type PublicKeyRecord = Awaited<ReturnType<DeploymentKeyStore['current']>>;

function publicRecord(row: KeyRow): PublicKeyRecord {
  if (!row.public_jwk_json || !row.encrypted_private_key) throw new Error('deployment_key_corrupt');
  return {
    deploymentId: row.deployment_id,
    keyId: row.key_id,
    keyRef: row.key_ref,
    publicJwk: row.public_jwk_json,
  };
}

function createMaterial(deploymentId: string, generation: number, encryptionKey: Uint8Array) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = publicKey.export({ format: 'jwk' }) as P256PublicJwk;
  const keyId = p256JwkThumbprint(publicJwk);
  const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  return {
    deploymentId,
    keyId,
    keyRef: `pgenc:${keyId}`,
    publicJwk,
    encryptedPrivateKey: encryptValue(privateDer, encryptionKey),
    generation,
  };
}

/**
 * 共享 PostgreSQL + AES-256-GCM 的部署密钥实现。数据库只保存密文，主密钥由业务部署
 * 自身的 Secret 管理注入；它不是任何组织的安装凭据，后续接入组织无需修改或重启。
 */
export class PgEncryptedDeploymentKeyStore implements DeploymentKeyStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionKey: Uint8Array,
  ) {}

  async current(): Promise<PublicKeyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 所有副本共用同一个事务锁，防止首次启动各自生成一个 deploymentId。
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('ky_app_deployment_identity'))`);
      const existing = await this.findWith(client, 'current');
      if (existing) {
        await client.query('COMMIT');
        return publicRecord(existing);
      }
      const deploymentId = `dep_${randomBytes(16).toString('base64url')}`;
      const value = createMaterial(deploymentId, 1, this.encryptionKey);
      await client.query(
        `INSERT INTO ky_app_deployment_key_refs
         (deployment_id,key_id,key_ref,public_jwk_json,encrypted_private_key,status,generation)
         VALUES($1,$2,$3,$4::jsonb,$5,'current',$6)`,
        [
          value.deploymentId,
          value.keyId,
          value.keyRef,
          JSON.stringify(value.publicJwk),
          value.encryptedPrivateKey,
          value.generation,
        ],
      );
      await client.query('COMMIT');
      return {
        deploymentId: value.deploymentId,
        keyId: value.keyId,
        keyRef: value.keyRef,
        publicJwk: value.publicJwk,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async sign(keyRef: string, payload: Uint8Array): Promise<Uint8Array> {
    const result = await this.pool.query<KeyRow>(
      `SELECT * FROM ky_app_deployment_key_refs
       WHERE key_ref=$1 AND status IN ('current','next','previous')`,
      [keyRef],
    );
    const row = result.rows[0];
    if (!row?.encrypted_private_key) throw new Error('deployment_key_not_found');
    const privateKey = createPrivateKey({
      key: decryptValue(row.encrypted_private_key, this.encryptionKey),
      format: 'der',
      type: 'pkcs8',
    });
    return sign('sha256', payload, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  }

  async prepareRotation(): Promise<PublicKeyRecord> {
    const current = await this.requireCurrent();
    const existing = await this.find('next', current.deployment_id);
    if (existing) return publicRecord(existing);
    const value = createMaterial(
      current.deployment_id,
      Number(current.generation) + 1,
      this.encryptionKey,
    );
    try {
      await this.pool.query(
        `INSERT INTO ky_app_deployment_key_refs
         (deployment_id,key_id,key_ref,public_jwk_json,encrypted_private_key,status,generation)
         VALUES($1,$2,$3,$4::jsonb,$5,'next',$6)`,
        [
          value.deploymentId,
          value.keyId,
          value.keyRef,
          JSON.stringify(value.publicJwk),
          value.encryptedPrivateKey,
          value.generation,
        ],
      );
      return {
        deploymentId: value.deploymentId,
        keyId: value.keyId,
        keyRef: value.keyRef,
        publicJwk: value.publicJwk,
      };
    } catch (error) {
      const winner = await this.find('next', current.deployment_id);
      if (winner) return publicRecord(winner);
      throw error;
    }
  }

  async commitRotation(keyId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const next = await this.findWith(client, 'next');
      const current = await this.findWith(client, 'current');
      if (
        !next ||
        !current ||
        next.key_id !== keyId ||
        next.deployment_id !== current.deployment_id
      ) {
        throw new Error('deployment_key_rotation_conflict');
      }
      await client.query(
        `UPDATE ky_app_deployment_key_refs SET status='previous',updated_at=now()
         WHERE deployment_id=$1 AND key_id=$2 AND status='current'`,
        [current.deployment_id, current.key_id],
      );
      const promoted = await client.query(
        `UPDATE ky_app_deployment_key_refs SET status='current',updated_at=now()
         WHERE deployment_id=$1 AND key_id=$2 AND status='next'`,
        [next.deployment_id, next.key_id],
      );
      if (promoted.rowCount !== 1) throw new Error('deployment_key_rotation_conflict');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async requireCurrent(): Promise<KeyRow> {
    await this.current();
    const current = await this.find('current');
    if (!current) throw new Error('deployment_key_not_found');
    return current;
  }

  private async find(status: KeyRow['status'], deploymentId?: string): Promise<KeyRow | null> {
    const result = await this.pool.query<KeyRow>(
      `SELECT * FROM ky_app_deployment_key_refs WHERE status=$1
       AND ($2::text IS NULL OR deployment_id=$2) ORDER BY generation DESC LIMIT 1`,
      [status, deploymentId ?? null],
    );
    return result.rows[0] ?? null;
  }

  private async findWith(client: PoolClient, status: KeyRow['status']): Promise<KeyRow | null> {
    const result = await client.query<KeyRow>(
      `SELECT * FROM ky_app_deployment_key_refs WHERE status=$1
       ORDER BY generation DESC LIMIT 1 FOR UPDATE`,
      [status],
    );
    return result.rows[0] ?? null;
  }
}
