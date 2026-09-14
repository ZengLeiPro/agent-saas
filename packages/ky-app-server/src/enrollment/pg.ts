import { randomBytes } from 'node:crypto';

import type { P256PublicJwk } from '@kaiyan/ky-app-contract';
import type { Pool } from 'pg';

import { decryptValue, encryptValue } from '../identity/encryptedValue.js';
import type { EnrollmentAttempt, EnrollmentAttemptStore, EphemeralSecretStore } from './types.js';

interface AttemptRow {
  operation_id: string;
  installation_id: string;
  tenant_id: string;
  system_id: string;
  state_sha256: string;
  verifier_ref: string;
  key_id: string;
  deployment_id: string;
  public_jwk_json: P256PublicJwk;
  status: EnrollmentAttempt['status'];
  expires_at: Date;
}

function attempt(row: AttemptRow): EnrollmentAttempt {
  return {
    operationId: row.operation_id,
    installationId: row.installation_id,
    tenantId: row.tenant_id,
    systemId: row.system_id,
    stateHash: row.state_sha256,
    verifierRef: row.verifier_ref,
    keyId: row.key_id,
    deploymentId: row.deployment_id,
    publicJwk: row.public_jwk_json,
    status: row.status,
    expiresAt: row.expires_at.getTime(),
  };
}

export class PgEnrollmentAttemptStore implements EnrollmentAttemptStore {
  constructor(private readonly pool: Pool) {}

  async create(value: EnrollmentAttempt): Promise<EnrollmentAttempt> {
    await this.pool.query(
      `INSERT INTO ky_app_enrollment_attempts
       (operation_id,installation_id,tenant_id,system_id,state_sha256,verifier_ref,key_id,
        deployment_id,public_jwk_json,status,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
       ON CONFLICT (operation_id) DO NOTHING`,
      [
        value.operationId,
        value.installationId,
        value.tenantId,
        value.systemId,
        value.stateHash,
        value.verifierRef,
        value.keyId,
        value.deploymentId,
        JSON.stringify(value.publicJwk),
        value.status,
        new Date(value.expiresAt),
      ],
    );
    const stored = await this.get(value.operationId);
    if (!stored) throw new Error('enrollment_attempt_write_failed');
    return stored;
  }

  async get(operationId: string): Promise<EnrollmentAttempt | null> {
    await this.expire();
    const result = await this.pool.query<AttemptRow>(
      'SELECT * FROM ky_app_enrollment_attempts WHERE operation_id=$1',
      [operationId],
    );
    return result.rows[0] ? attempt(result.rows[0]) : null;
  }

  async getByStateHash(stateHash: string): Promise<EnrollmentAttempt | null> {
    await this.expire();
    const result = await this.pool.query<AttemptRow>(
      'SELECT * FROM ky_app_enrollment_attempts WHERE state_sha256=$1 ORDER BY created_at DESC LIMIT 1',
      [stateHash],
    );
    return result.rows[0] ? attempt(result.rows[0]) : null;
  }

  async beginExchange(operationId: string, now: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ky_app_enrollment_attempts SET status='exchanging',updated_at=now()
       WHERE operation_id=$1 AND status IN ('pending','exchanging') AND expires_at>$2`,
      [operationId, new Date(now)],
    );
    return result.rowCount === 1;
  }

  async finish(operationId: string, status: 'consumed' | 'failed'): Promise<void> {
    const result = await this.pool.query(
      `UPDATE ky_app_enrollment_attempts SET status=$2,
         consumed_at=CASE WHEN $2='consumed' THEN now() ELSE consumed_at END,updated_at=now()
       WHERE operation_id=$1 AND status='exchanging'`,
      [operationId, status],
    );
    if (result.rowCount !== 1) throw new Error('enrollment_attempt_conflict');
  }

  private async expire(): Promise<void> {
    await this.pool.query(
      `UPDATE ky_app_enrollment_attempts SET status='expired',updated_at=now()
       WHERE status IN ('pending','exchanging') AND expires_at<=now()`,
    );
  }
}

export class PgEncryptedEphemeralSecretStore implements EphemeralSecretStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionKey: Uint8Array,
  ) {}

  async put(value: string, expiresAt: number): Promise<string> {
    const ref = `pgenc:${randomBytes(16).toString('base64url')}`;
    await this.pool.query(
      `INSERT INTO ky_app_enrollment_secrets(secret_ref,encrypted_value,expires_at)
       VALUES($1,$2,$3)`,
      [ref, encryptValue(Buffer.from(value, 'utf8'), this.encryptionKey), new Date(expiresAt)],
    );
    return ref;
  }

  async get(ref: string): Promise<string | null> {
    const result = await this.pool.query<{ encrypted_value: string }>(
      `SELECT encrypted_value FROM ky_app_enrollment_secrets
       WHERE secret_ref=$1 AND expires_at>now()`,
      [ref],
    );
    return result.rows[0]
      ? decryptValue(result.rows[0].encrypted_value, this.encryptionKey).toString('utf8')
      : null;
  }

  async set(ref: string, value: string, expiresAt: number): Promise<void> {
    const result = await this.pool.query(
      `UPDATE ky_app_enrollment_secrets SET encrypted_value=$2,expires_at=$3,updated_at=now()
       WHERE secret_ref=$1`,
      [ref, encryptValue(Buffer.from(value, 'utf8'), this.encryptionKey), new Date(expiresAt)],
    );
    if (result.rowCount !== 1) throw new Error('secret_ref_not_found');
  }

  async delete(ref: string): Promise<void> {
    await this.pool.query('DELETE FROM ky_app_enrollment_secrets WHERE secret_ref=$1', [ref]);
  }
}
