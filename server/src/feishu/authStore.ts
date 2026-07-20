import { randomUUID } from 'node:crypto';

import pg from 'pg';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export const FEISHU_AUTH_SESSION_TTL_MS = 15 * 60 * 1_000;

export type FeishuAuthSessionStatus = 'starting' | 'awaiting_user' | 'connected' | 'failed' | 'expired';

export interface FeishuAuthSessionIdentity {
  tenantId: string;
  userId: string;
  username: string;
}

export interface FeishuAuthSessionRecord extends FeishuAuthSessionIdentity {
  sessionId: string;
  status: FeishuAuthSessionStatus;
  authorizationUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface FeishuAuthSessionStore {
  createOrReuse(identity: FeishuAuthSessionIdentity, now?: Date): Promise<{ record: FeishuAuthSessionRecord; created: boolean }>;
  markAwaitingUser(sessionId: string, identity: FeishuAuthSessionIdentity, authorizationUrl: string, now?: Date): Promise<void>;
  markConnected(sessionId: string, identity: FeishuAuthSessionIdentity, now?: Date): Promise<void>;
  markFailed(sessionId: string, identity: FeishuAuthSessionIdentity, errorCode: string, errorMessage: string, now?: Date): Promise<void>;
  getLatestForUser(tenantId: string, userId: string): Promise<FeishuAuthSessionRecord | null>;
}

export class PgFeishuAuthSessionStore implements FeishuAuthSessionStore {
  readonly table: string;

  constructor(private readonly options: { pool: PgPool; tablePrefix?: string }) {
    this.table = `${sanitizeIdentifier(options.tablePrefix ?? 'runtime')}_feishu_auth_sessions`;
  }

  async init(): Promise<void> {
    const client = await this.options.pool.connect();
    const lockKey = `${this.table}:init`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query('BEGIN');
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          session_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          status TEXT NOT NULL,
          authorization_url TEXT,
          error_code TEXT,
          error_message TEXT,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          CHECK (status IN ('starting', 'awaiting_user', 'connected', 'failed', 'expired'))
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.table}_user_idx
        ON ${this.table} (tenant_id, user_id, created_at DESC)
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ${this.table}_active_user_idx
        ON ${this.table} (tenant_id, user_id)
        WHERE status IN ('starting', 'awaiting_user')
      `);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async createOrReuse(
    identity: FeishuAuthSessionIdentity,
    now = new Date(),
  ): Promise<{ record: FeishuAuthSessionRecord; created: boolean }> {
    const client = await this.options.pool.connect();
    const lockKey = `feishu-auth:${identity.tenantId}:${identity.userId}`;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
      await client.query(`
        UPDATE ${this.table}
        SET status = 'expired', error_code = 'authorization_expired',
            error_message = '授权链接已过期，请重新连接', completed_at = $3, updated_at = $3
        WHERE tenant_id = $1 AND user_id = $2
          AND status IN ('starting', 'awaiting_user') AND expires_at <= $3
      `, [identity.tenantId, identity.userId, now.toISOString()]);

      const active = await client.query(`
        SELECT * FROM ${this.table}
        WHERE tenant_id = $1 AND user_id = $2 AND status IN ('starting', 'awaiting_user')
        ORDER BY created_at DESC LIMIT 1
      `, [identity.tenantId, identity.userId]);
      if (active.rows[0]) {
        await client.query('COMMIT');
        return { record: mapRow(active.rows[0]), created: false };
      }

      const sessionId = randomUUID();
      const expiresAt = new Date(now.getTime() + FEISHU_AUTH_SESSION_TTL_MS).toISOString();
      const inserted = await client.query(`
        INSERT INTO ${this.table} (
          session_id, tenant_id, user_id, username, status, expires_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'starting', $5, $6, $6)
        RETURNING *
      `, [sessionId, identity.tenantId, identity.userId, identity.username, expiresAt, now.toISOString()]);
      await client.query('COMMIT');
      return { record: mapRow(inserted.rows[0]), created: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async markAwaitingUser(
    sessionId: string,
    identity: FeishuAuthSessionIdentity,
    authorizationUrl: string,
    now = new Date(),
  ): Promise<void> {
    await this.options.pool.query(`
      UPDATE ${this.table}
      SET status = 'awaiting_user', authorization_url = $4, updated_at = $5
      WHERE session_id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'starting'
    `, [sessionId, identity.tenantId, identity.userId, authorizationUrl, now.toISOString()]);
  }

  async markConnected(sessionId: string, identity: FeishuAuthSessionIdentity, now = new Date()): Promise<void> {
    await this.options.pool.query(`
      UPDATE ${this.table}
      SET status = 'connected', authorization_url = NULL, error_code = NULL, error_message = NULL,
          completed_at = $4, updated_at = $4
      WHERE session_id = $1 AND tenant_id = $2 AND user_id = $3
    `, [sessionId, identity.tenantId, identity.userId, now.toISOString()]);
  }

  async markFailed(
    sessionId: string,
    identity: FeishuAuthSessionIdentity,
    errorCode: string,
    errorMessage: string,
    now = new Date(),
  ): Promise<void> {
    const status: FeishuAuthSessionStatus = errorCode === 'authorization_expired' ? 'expired' : 'failed';
    await this.options.pool.query(`
      UPDATE ${this.table}
      SET status = $4, authorization_url = NULL, error_code = $5, error_message = $6,
          completed_at = $7, updated_at = $7
      WHERE session_id = $1 AND tenant_id = $2 AND user_id = $3
    `, [sessionId, identity.tenantId, identity.userId, status, errorCode, errorMessage, now.toISOString()]);
  }

  async getLatestForUser(tenantId: string, userId: string): Promise<FeishuAuthSessionRecord | null> {
    const result = await this.options.pool.query(`
      SELECT * FROM ${this.table}
      WHERE tenant_id = $1 AND user_id = $2
      ORDER BY created_at DESC LIMIT 1
    `, [tenantId, userId]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }
}

function mapRow(row: Record<string, unknown>): FeishuAuthSessionRecord {
  return {
    sessionId: String(row.session_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    username: String(row.username),
    status: String(row.status) as FeishuAuthSessionStatus,
    ...(stringValue(row.authorization_url) ? { authorizationUrl: stringValue(row.authorization_url) } : {}),
    ...(stringValue(row.error_code) ? { errorCode: stringValue(row.error_code) } : {}),
    ...(stringValue(row.error_message) ? { errorMessage: stringValue(row.error_message) } : {}),
    expiresAt: isoValue(row.expires_at),
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at),
    ...(row.completed_at ? { completedAt: isoValue(row.completed_at) } : {}),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isoValue(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function sanitizeIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid SQL identifier: ${value}`);
  return value;
}
