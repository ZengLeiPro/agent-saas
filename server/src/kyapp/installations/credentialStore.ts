/**
 * WP2a 服务凭据与安装密钥元数据（规范 §3.2、§3.6、§8.4）。
 *
 * **库里只存 sha256 与 SecretVault ref**，明文一律经 vault 一次性领取，绝不回写、绝不落日志。
 * 服务凭据双凭据重叠轮换：新凭据 `pending_ack` → 24 小时内 `credential-ack` → `active` → 旧凭据 revoke。
 * 安装密钥按 `keyVersion` 轮换，验证端 24 小时同时接受 current / previous。
 */
import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

import {
  PgGovernanceMigrationRunner,
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';

/** 服务凭据 scope（规范 §3.6）。 */
export const KY_APP_CREDENTIAL_SCOPES = ['snapshot', 'changes', 'credential-ack'] as const;
export type KyAppCredentialScope = (typeof KY_APP_CREDENTIAL_SCOPES)[number];

export type KyAppCredentialStatus = 'pending_ack' | 'active' | 'revoked' | 'expired';
export type KyAppInstallationKeyStatus = 'current' | 'previous' | 'revoked';

export interface KyAppServiceCredentialRecord {
  credentialId: string;
  installationId: string;
  tokenSha256: string;
  scopes: KyAppCredentialScope[];
  status: KyAppCredentialStatus;
  secretRef: string;
  claimedAt: string | null;
  issuedAt: string;
  ackDeadlineAt: string;
  ackedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
}

export interface KyAppInstallationKeyRecord {
  installationId: string;
  keyVersion: string;
  secretRef: string;
  status: KyAppInstallationKeyStatus;
  createdAt: string;
  supersededAt: string | null;
  acceptUntil: string | null;
  revokedAt: string | null;
}

export class KyAppCredentialConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KyAppCredentialConflictError';
  }
}

/** 服务凭据只以 sha256 形态入库（规范 §8.4）。 */
export function serviceCredentialDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function rowToCredential(row: Row): KyAppServiceCredentialRecord {
  return {
    credentialId: String(row.credential_id),
    installationId: String(row.installation_id),
    tokenSha256: String(row.token_sha256),
    scopes: Array.isArray(row.scopes) ? (row.scopes as KyAppCredentialScope[]) : [],
    status: String(row.status) as KyAppCredentialStatus,
    secretRef: String(row.secret_ref),
    claimedAt: isoOrNull(row.claimed_at),
    issuedAt: iso(row.issued_at),
    ackDeadlineAt: iso(row.ack_deadline_at),
    ackedAt: isoOrNull(row.acked_at),
    expiresAt: iso(row.expires_at),
    revokedAt: isoOrNull(row.revoked_at),
  };
}

function rowToKey(row: Row): KyAppInstallationKeyRecord {
  return {
    installationId: String(row.installation_id),
    keyVersion: String(row.key_version),
    secretRef: String(row.secret_ref),
    status: String(row.status) as KyAppInstallationKeyStatus,
    createdAt: iso(row.created_at),
    supersededAt: isoOrNull(row.superseded_at),
    acceptUntil: isoOrNull(row.accept_until),
    revokedAt: isoOrNull(row.revoked_at),
  };
}

export interface PgKyAppCredentialStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

export class PgKyAppCredentialStore {
  readonly credentialsTable: string;
  readonly keysTable: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: PgKyAppCredentialStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.tablePrefix = options.tablePrefix;
    this.credentialsTable = `${prefix}_ky_app_service_credentials`;
    this.keysTable = `${prefix}_ky_app_installation_keys`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  /** 登记一条新签发的服务凭据；参数只接受明文的 sha256，不接受明文本身。 */
  async issueCredential(input: {
    credentialId: string;
    installationId: string;
    tokenSha256: string;
    scopes: readonly KyAppCredentialScope[];
    secretRef: string;
    ackDeadlineAt: Date;
    expiresAt: Date;
  }): Promise<KyAppServiceCredentialRecord> {
    const result = await this.options.pool.query(
      `INSERT INTO ${this.credentialsTable}
         (credential_id,installation_id,token_sha256,scopes,status,secret_ref,ack_deadline_at,expires_at)
       VALUES ($1,$2,$3,$4::jsonb,'pending_ack',$5,$6,$7)
       RETURNING *`,
      [
        input.credentialId,
        input.installationId,
        input.tokenSha256,
        JSON.stringify([...input.scopes]),
        input.secretRef,
        input.ackDeadlineAt,
        input.expiresAt,
      ],
    );
    return rowToCredential(result.rows[0] as Row);
  }

  /** 按明文查凭据（鉴权路径用）；只做 sha256 等值查找，明文不入库不入日志。 */
  async findByToken(token: string): Promise<KyAppServiceCredentialRecord | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.credentialsTable} WHERE token_sha256 = $1`,
      [serviceCredentialDigest(token)],
    );
    return result.rows[0] ? rowToCredential(result.rows[0] as Row) : null;
  }

  async listCredentials(installationId: string): Promise<KyAppServiceCredentialRecord[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.credentialsTable} WHERE installation_id=$1 ORDER BY issued_at DESC`,
      [installationId],
    );
    return result.rows.map((row) => rowToCredential(row as Row));
  }

  /** 一次性领取：只允许标记一次，第二次返回 null（明文本身由 vault 侧控制）。 */
  async markClaimed(credentialId: string): Promise<KyAppServiceCredentialRecord | null> {
    const result = await this.options.pool.query(
      `UPDATE ${this.credentialsTable}
       SET claimed_at=NOW() WHERE credential_id=$1 AND claimed_at IS NULL RETURNING *`,
      [credentialId],
    );
    return result.rows[0] ? rowToCredential(result.rows[0] as Row) : null;
  }

  /** `credential-ack`：24 小时内确认才生效，超时返回 null（调用方按失效处理）。 */
  async acknowledge(credentialId: string, now: Date): Promise<KyAppServiceCredentialRecord | null> {
    const result = await this.options.pool.query(
      `UPDATE ${this.credentialsTable}
       SET status='active', acked_at=$2
       WHERE credential_id=$1 AND status='pending_ack' AND ack_deadline_at > $2
       RETURNING *`,
      [credentialId, now],
    );
    return result.rows[0] ? rowToCredential(result.rows[0] as Row) : null;
  }

  async revokeCredential(credentialId: string): Promise<KyAppServiceCredentialRecord | null> {
    const result = await this.options.pool.query(
      `UPDATE ${this.credentialsTable}
       SET status='revoked', revoked_at=NOW()
       WHERE credential_id=$1 AND status <> 'revoked' RETURNING *`,
      [credentialId],
    );
    return result.rows[0] ? rowToCredential(result.rows[0] as Row) : null;
  }

  /** 把未确认超时与到期的凭据统一标为 expired，返回受影响条数。 */
  async expireStale(now: Date): Promise<number> {
    const result = await this.options.pool.query(
      `UPDATE ${this.credentialsTable}
       SET status='expired'
       WHERE (status='pending_ack' AND ack_deadline_at <= $1)
          OR (status IN ('pending_ack','active') AND expires_at <= $1)`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  async getInstallationKeys(installationId: string): Promise<KyAppInstallationKeyRecord[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.keysTable} WHERE installation_id=$1 ORDER BY created_at DESC`,
      [installationId],
    );
    return result.rows.map((row) => rowToKey(row as Row));
  }

  /**
   * 轮入一把新的安装密钥：原 current 转 previous 并给出 24 小时接受窗口，
   * 新 keyVersion 成为 current。整个切换在一个事务里完成（每实例唯一 current 由部分唯一索引兜底）。
   */
  async rotateInstallationKey(input: {
    installationId: string;
    keyVersion: string;
    secretRef: string;
    acceptPreviousMs: number;
  }): Promise<KyAppInstallationKeyRecord> {
    return this.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ky_app_installation_key:${input.installationId}`,
      ]);
      const duplicate = await client.query(
        `SELECT * FROM ${this.keysTable} WHERE installation_id=$1 AND key_version=$2`,
        [input.installationId, input.keyVersion],
      );
      if (duplicate.rows[0]) {
        throw new KyAppCredentialConflictError(`安装密钥 keyVersion 已存在：${input.keyVersion}`);
      }
      // 旧的 previous 直接撤销：验证端最多同时接受两代（current / previous）。
      await client.query(
        `UPDATE ${this.keysTable} SET status='revoked', revoked_at=NOW()
         WHERE installation_id=$1 AND status='previous'`,
        [input.installationId],
      );
      await client.query(
        `UPDATE ${this.keysTable}
         SET status='previous', superseded_at=NOW(),
             accept_until=NOW() + make_interval(secs => $2)
         WHERE installation_id=$1 AND status='current'`,
        [input.installationId, Math.max(0, Math.floor(input.acceptPreviousMs / 1000))],
      );
      const inserted = await client.query(
        `INSERT INTO ${this.keysTable} (installation_id,key_version,secret_ref,status)
         VALUES ($1,$2,$3,'current') RETURNING *`,
        [input.installationId, input.keyVersion, input.secretRef],
      );
      return rowToKey(inserted.rows[0] as Row);
    });
  }

  /** 按 kid（= keyVersion）取可用密钥元数据；previous 超出接受窗口即不可用。 */
  async findAcceptableKey(
    installationId: string,
    keyVersion: string,
    now: Date,
  ): Promise<KyAppInstallationKeyRecord | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.keysTable}
       WHERE installation_id=$1 AND key_version=$2
         AND (status='current' OR (status='previous' AND accept_until > $3))`,
      [installationId, keyVersion, now],
    );
    return result.rows[0] ? rowToKey(result.rows[0] as Row) : null;
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
