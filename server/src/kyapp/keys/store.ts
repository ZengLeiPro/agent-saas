/**
 * WP2a SAT 签名密钥登记表（规范 §3.1、§8.4）。
 *
 * 表里只有公钥 JWK、`kid`、状态与 SecretVault 引用；**私钥永远不入库、不入日志**。
 * 状态机：`next → active → retiring → revoked`；`active`/`next` 各自最多一把（由 v41 的部分唯一索引兜底）。
 */
import type { PoolClient } from 'pg';

import {
  PgGovernanceMigrationRunner,
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';

export const KY_APP_SIGNING_KEY_STATUSES = ['active', 'next', 'retiring', 'revoked'] as const;
export type KyAppSigningKeyStatus = (typeof KY_APP_SIGNING_KEY_STATUSES)[number];

export interface KyAppSigningKeyRecord {
  kid: string;
  /** 公钥 JWK（`kty=EC crv=P-256 use=sig`），JWKS 直接取用。 */
  publicJwk: Record<string, unknown>;
  /** SecretVault 中 PKCS8 私钥的 ref id。 */
  secretRef: string;
  status: KyAppSigningKeyStatus;
  createdAt: string;
  activatedAt: string | null;
  retiringAt: string | null;
  /** `retiring` 状态下的下线时刻（规范 §8.4：24 小时）。 */
  retireAfter: string | null;
  revokedAt: string | null;
}

export class KyAppSigningKeyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KyAppSigningKeyConflictError';
  }
}

type Row = Record<string, unknown>;

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowToKey(row: Row): KyAppSigningKeyRecord {
  return {
    kid: String(row.kid),
    publicJwk: row.public_jwk as Record<string, unknown>,
    secretRef: String(row.secret_ref),
    status: String(row.status) as KyAppSigningKeyStatus,
    createdAt: isoOrNull(row.created_at) ?? new Date(0).toISOString(),
    activatedAt: isoOrNull(row.activated_at),
    retiringAt: isoOrNull(row.retiring_at),
    retireAfter: isoOrNull(row.retire_after),
    revokedAt: isoOrNull(row.revoked_at),
  };
}

export interface PgKyAppSigningKeyStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

export class PgKyAppSigningKeyStore {
  readonly table: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: PgKyAppSigningKeyStoreOptions) {
    this.tablePrefix = options.tablePrefix;
    this.table = `${governanceTablePrefix(options.tablePrefix)}_ky_app_signing_keys`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async get(kid: string): Promise<KyAppSigningKeyRecord | null> {
    const result = await this.options.pool.query(`SELECT * FROM ${this.table} WHERE kid = $1`, [
      kid,
    ]);
    return result.rows[0] ? rowToKey(result.rows[0] as Row) : null;
  }

  /** JWKS 只暴露 active / next / retiring（规范 §8.4）。 */
  async listPublishable(): Promise<KyAppSigningKeyRecord[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.table}
       WHERE status IN ('active','next','retiring') ORDER BY created_at`,
    );
    return result.rows.map((row) => rowToKey(row as Row));
  }

  async findByStatus(status: KyAppSigningKeyStatus): Promise<KyAppSigningKeyRecord | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.table} WHERE status = $1 ORDER BY created_at LIMIT 1`,
      [status],
    );
    return result.rows[0] ? rowToKey(result.rows[0] as Row) : null;
  }

  async listByStatus(status: KyAppSigningKeyStatus): Promise<KyAppSigningKeyRecord[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.table} WHERE status = $1 ORDER BY created_at`,
      [status],
    );
    return result.rows.map((row) => rowToKey(row as Row));
  }

  /** 插入一把新密钥（`active` 或 `next`）。违反唯一约束即抛冲突，由调用方重试或让位。 */
  async insert(input: {
    kid: string;
    publicJwk: Record<string, unknown>;
    secretRef: string;
    status: 'active' | 'next';
  }): Promise<KyAppSigningKeyRecord> {
    try {
      const result = await this.options.pool.query(
        `INSERT INTO ${this.table} (kid,public_jwk,secret_ref,status,activated_at)
         VALUES ($1,$2::jsonb,$3,$4,CASE WHEN $4 = 'active' THEN NOW() ELSE NULL END)
         RETURNING *`,
        [input.kid, JSON.stringify(input.publicJwk), input.secretRef, input.status],
      );
      return rowToKey(result.rows[0] as Row);
    } catch (error) {
      throw new KyAppSigningKeyConflictError(
        `登记签名密钥失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 把 `next` 提升为 `active`，原 `active` 转 `retiring`（24 小时后下线）。
   * 整个切换在一个事务里完成，任何一步失败都不留下两把 active。
   */
  async promote(kid: string, retireAfterMs: number): Promise<KyAppSigningKeyRecord> {
    return this.withTransaction(async (client) => {
      const target = await this.lock(client, kid);
      if (target.status !== 'next') {
        throw new KyAppSigningKeyConflictError(
          `只有 next 状态的密钥可以提升，当前 ${target.status}`,
        );
      }
      await client.query(
        `UPDATE ${this.table}
         SET status='retiring', retiring_at=NOW(), retire_after=NOW() + make_interval(secs => $1)
         WHERE status='active'`,
        [Math.max(0, Math.floor(retireAfterMs / 1000))],
      );
      const promoted = await client.query(
        `UPDATE ${this.table} SET status='active', activated_at=NOW() WHERE kid=$1 RETURNING *`,
        [kid],
      );
      return rowToKey(promoted.rows[0] as Row);
    });
  }

  /** 紧急撤销（规范 §8.4）：立即移出 JWKS。 */
  async revoke(kid: string): Promise<KyAppSigningKeyRecord> {
    const result = await this.options.pool.query(
      `UPDATE ${this.table} SET status='revoked', revoked_at=NOW() WHERE kid=$1 RETURNING *`,
      [kid],
    );
    if (!result.rows[0]) throw new KyAppSigningKeyConflictError(`未知 kid ${kid}`);
    return rowToKey(result.rows[0] as Row);
  }

  /** 到期下线：`retiring` 且已过 `retire_after` 的密钥转 `revoked`，返回受影响的 kid。 */
  async retireExpired(now: Date): Promise<string[]> {
    const result = await this.options.pool.query<{ kid: string }>(
      `UPDATE ${this.table}
       SET status='revoked', revoked_at=NOW()
       WHERE status='retiring' AND retire_after IS NOT NULL AND retire_after <= $1
       RETURNING kid`,
      [now],
    );
    return result.rows.map((row) => String(row.kid));
  }

  private async lock(client: PoolClient, kid: string): Promise<KyAppSigningKeyRecord> {
    const result = await client.query(`SELECT * FROM ${this.table} WHERE kid=$1 FOR UPDATE`, [kid]);
    if (!result.rows[0]) throw new KyAppSigningKeyConflictError(`未知 kid ${kid}`);
    return rowToKey(result.rows[0] as Row);
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['ky_app_signing_keys']);
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
