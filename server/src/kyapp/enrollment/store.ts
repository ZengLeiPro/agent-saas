import type { PoolClient } from 'pg';

import {
  PgGovernanceMigrationRunner,
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';
import type { EnrollmentOperation, VerifiedEnrollmentChallenge } from './types.js';

type Row = Record<string, unknown>;

export class EnrollmentStoreError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'operation_conflict'
      | 'operation_not_found'
      | 'invalid_state'
      | 'authorization_code_expired'
      | 'authorization_code_replayed'
      | 'binding_changed',
  ) {
    super(message);
    this.name = 'EnrollmentStoreError';
  }
}

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value ?? new Date(0).toISOString());
const nullable = (value: unknown): string | null =>
  value === null || value === undefined ? null : iso(value);

function rowToOperation(row: Row): EnrollmentOperation {
  return {
    operationId: String(row.operation_id),
    installationId: String(row.installation_id),
    actorUserId: String(row.actor_user_id),
    requestDigest: String(row.request_digest),
    deploymentId: row.deployment_id == null ? null : String(row.deployment_id),
    keyId: row.key_id == null ? null : String(row.key_id),
    publicJwk: row.public_jwk_json as EnrollmentOperation['publicJwk'],
    origin: row.origin == null ? null : String(row.origin),
    callbackUrl: row.callback_url == null ? null : String(row.callback_url),
    callbackState: row.callback_state == null ? null : String(row.callback_state),
    pkceChallenge: row.pkce_challenge == null ? null : String(row.pkce_challenge),
    grantedScopes: Array.isArray(row.granted_scopes) ? (row.granted_scopes as string[]) : [],
    status: String(row.status) as EnrollmentOperation['status'],
    version: Number(row.version),
    codeExpiresAt: nullable(row.code_expires_at),
    codeConsumedAt: nullable(row.code_consumed_at),
    grantJti: row.grant_jti == null ? null : String(row.grant_jti),
    result: (row.result_json as Record<string, unknown>) ?? {},
    lastErrorCode: row.last_error_code == null ? null : String(row.last_error_code),
    diagnosticId: row.diagnostic_id == null ? null : String(row.diagnostic_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface EnrollmentStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

export class PgEnrollmentStore {
  readonly operationsTable: string;
  readonly installationsTable: string;
  readonly keysTable: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: EnrollmentStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.tablePrefix = options.tablePrefix;
    this.operationsTable = `${prefix}_ky_app_enrollment_operations`;
    this.installationsTable = `${prefix}_ky_app_tenant_system_installations`;
    this.keysTable = `${prefix}_ky_app_deployment_keys`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async get(operationId: string): Promise<EnrollmentOperation | null> {
    await this.options.pool.query(
      `UPDATE ${this.operationsTable} SET status='expired',version=version+1,updated_at=clock_timestamp()
       WHERE operation_id=$1 AND status='code_issued' AND code_expires_at <= clock_timestamp()`,
      [operationId],
    );
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.operationsTable} WHERE operation_id=$1`,
      [operationId],
    );
    return result.rows[0] ? rowToOperation(result.rows[0] as Row) : null;
  }

  async getByCodeHash(codeSha256: string): Promise<EnrollmentOperation | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.operationsTable} WHERE code_sha256=$1`,
      [codeSha256],
    );
    return result.rows[0] ? rowToOperation(result.rows[0] as Row) : null;
  }

  async getLatestExchanged(installationId: string): Promise<EnrollmentOperation | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.operationsTable}
       WHERE installation_id=$1 AND status IN ('exchanged','activating','ready')
       ORDER BY code_consumed_at DESC NULLS LAST, updated_at DESC LIMIT 1`,
      [installationId],
    );
    return result.rows[0] ? rowToOperation(result.rows[0] as Row) : null;
  }

  async createOrGet(input: {
    operationId: string;
    installationId: string;
    actorUserId: string;
    requestDigest: string;
  }): Promise<{ operation: EnrollmentOperation; created: boolean }> {
    const inserted = await this.options.pool.query(
      `INSERT INTO ${this.operationsTable}
        (operation_id,installation_id,actor_user_id,request_digest)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (operation_id) DO NOTHING RETURNING *`,
      [input.operationId, input.installationId, input.actorUserId, input.requestDigest],
    );
    if (inserted.rows[0])
      return { operation: rowToOperation(inserted.rows[0] as Row), created: true };
    const existing = await this.get(input.operationId);
    if (!existing) throw new EnrollmentStoreError('operation 竞争后不可读', 'operation_conflict');
    if (
      existing.installationId !== input.installationId ||
      existing.actorUserId !== input.actorUserId ||
      existing.requestDigest !== input.requestDigest
    ) {
      throw new EnrollmentStoreError('operationId 已绑定不同请求', 'operation_conflict');
    }
    return { operation: existing, created: false };
  }

  async recordChallenge(
    operationId: string,
    challenge: VerifiedEnrollmentChallenge,
  ): Promise<EnrollmentOperation> {
    const result = await this.options.pool.query(
      `UPDATE ${this.operationsTable} SET
        deployment_id=$2,key_id=$3,public_jwk_json=$4::jsonb,origin=$5,callback_url=$6,
        callback_state=$7,pkce_challenge=$8,granted_scopes=$9::jsonb,status='awaiting_consent',
        version=version+1,updated_at=clock_timestamp()
       WHERE operation_id=$1 AND status IN ('created','challenge_verified') RETURNING *`,
      [
        operationId,
        challenge.deploymentId,
        challenge.keyId,
        JSON.stringify(challenge.publicJwk),
        challenge.origin,
        challenge.callbackUrl,
        challenge.callbackState,
        challenge.pkceChallenge,
        JSON.stringify(challenge.scopes),
      ],
    );
    if (!result.rows[0])
      throw new EnrollmentStoreError('当前状态不能记录 challenge', 'invalid_state');
    return rowToOperation(result.rows[0] as Row);
  }

  async issueCode(input: {
    operationId: string;
    actorUserId: string;
    codeSha256: string;
    expiresAt: Date;
  }): Promise<EnrollmentOperation> {
    const result = await this.options.pool.query(
      `UPDATE ${this.operationsTable} SET
        code_sha256=$3,code_expires_at=$4,status='code_issued',version=version+1,
        updated_at=clock_timestamp()
       WHERE operation_id=$1 AND actor_user_id=$2 AND status='awaiting_consent' RETURNING *`,
      [input.operationId, input.actorUserId, input.codeSha256, input.expiresAt],
    );
    if (!result.rows[0]) throw new EnrollmentStoreError('当前状态不能签发授权码', 'invalid_state');
    return rowToOperation(result.rows[0] as Row);
  }

  async commitExchange(input: {
    codeSha256: string;
    now: Date;
    deploymentId: string;
    keyId: string;
    grantJti: string;
    result: Record<string, unknown>;
  }): Promise<{ operation: EnrollmentOperation; alreadyCommitted: boolean }> {
    return this.withTransaction(async (client) => {
      const selected = await client.query(
        `SELECT * FROM ${this.operationsTable} WHERE code_sha256=$1 FOR UPDATE`,
        [input.codeSha256],
      );
      if (!selected.rows[0]) throw new EnrollmentStoreError('授权码不存在', 'operation_not_found');
      const operation = rowToOperation(selected.rows[0] as Row);
      if (operation.codeConsumedAt) {
        if (operation.deploymentId === input.deploymentId && operation.keyId === input.keyId) {
          return { operation, alreadyCommitted: true };
        }
        throw new EnrollmentStoreError('授权码已被其他身份消费', 'authorization_code_replayed');
      }
      if (operation.status !== 'code_issued') {
        throw new EnrollmentStoreError('授权码状态不可兑换', 'invalid_state');
      }
      if (!operation.codeExpiresAt || new Date(operation.codeExpiresAt) <= input.now) {
        throw new EnrollmentStoreError('授权码已过期', 'authorization_code_expired');
      }
      if (operation.deploymentId !== input.deploymentId || operation.keyId !== input.keyId) {
        throw new EnrollmentStoreError('部署身份与授权码绑定不一致', 'binding_changed');
      }
      await client.query(
        `INSERT INTO ${this.keysTable}
          (installation_id,key_id,deployment_id,public_jwk_json,status,generation)
         VALUES ($1,$2,$3,$4::jsonb,'current',1)
         ON CONFLICT (installation_id,key_id) DO NOTHING`,
        [
          operation.installationId,
          operation.keyId,
          operation.deploymentId,
          JSON.stringify(operation.publicJwk),
        ],
      );
      const installation = await client.query(
        `UPDATE ${this.installationsTable} SET
          auth_mode='v2_asymmetric',deployment_id=$2,current_key_id=$3,identity_generation=1,
          state_version=state_version+1,updated_at=clock_timestamp(),updated_by=$4
         WHERE installation_id=$1 AND status <> 'deleted'
           AND (auth_mode='v1_symmetric' OR
             (deployment_id=$2 AND current_key_id=$3 AND identity_generation=1))
         RETURNING installation_id`,
        [operation.installationId, operation.deploymentId, operation.keyId, operation.actorUserId],
      );
      if (!installation.rows[0]) {
        throw new EnrollmentStoreError('安装实例身份已变化', 'binding_changed');
      }
      const updated = await client.query(
        `UPDATE ${this.operationsTable} SET
          status='exchanged',code_consumed_at=clock_timestamp(),grant_jti=$2,
          result_json=$3::jsonb,version=version+1,updated_at=clock_timestamp()
         WHERE operation_id=$1 RETURNING *`,
        [operation.operationId, input.grantJti, JSON.stringify(input.result)],
      );
      return { operation: rowToOperation(updated.rows[0] as Row), alreadyCommitted: false };
    });
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
