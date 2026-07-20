import pg from 'pg';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export const FEISHU_KEEPALIVE_INTERVAL_MS = 5 * 24 * 60 * 60 * 1_000;
export const FEISHU_REFRESH_SAFETY_WINDOW_MS = 2 * 24 * 60 * 60 * 1_000;
export const FEISHU_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const FEISHU_ACCESS_REFRESH_RETRY_MS = 3 * 60 * 60 * 1_000;

export type FeishuConnectionStatus = 'pending' | 'connected' | 'error' | 'disconnected';

export interface FeishuConnectionIdentity {
  tenantId: string;
  userId: string;
  username: string;
}

export interface FeishuLoginMetadata {
  profileId: string;
  appId: string;
  userOpenId: string;
  userName?: string;
  scope?: string;
}

export interface FeishuConnectionRecord extends FeishuConnectionIdentity, FeishuLoginMetadata {
  connectionStatus: FeishuConnectionStatus;
  authenticated?: boolean;
  verified?: boolean;
  tokenStatus?: string;
  expiresAt?: string;
  refreshExpiresAt?: string;
  lastCheckedAt?: string;
  nextCheckAt: string;
  lastError?: string;
  consecutiveFailures: number;
  leaseOwner?: string;
  leaseUntil?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeishuAuthCheckResult {
  authenticated: boolean;
  verified: boolean;
  tokenStatus?: string;
  userOpenId?: string;
  userName?: string;
  scope?: string;
  expiresAt?: string;
  refreshExpiresAt?: string;
  error?: string;
}

export interface FeishuConnectionStore {
  upsertLogin(identity: FeishuConnectionIdentity, login: FeishuLoginMetadata, now?: Date): Promise<void>;
  claimDue(workerId: string, now?: Date, leaseMs?: number): Promise<FeishuConnectionRecord | null>;
  completeCheck(record: FeishuConnectionRecord, workerId: string, result: FeishuAuthCheckResult, now?: Date): Promise<void>;
  failCheck(record: FeishuConnectionRecord, workerId: string, error: string, now?: Date): Promise<void>;
  releaseClaim(record: FeishuConnectionRecord, workerId: string): Promise<void>;
  listForUser(tenantId: string, userId: string): Promise<FeishuConnectionRecord[]>;
}

export class PgFeishuConnectionStore implements FeishuConnectionStore {
  readonly table: string;

  constructor(private readonly options: { pool: PgPool; tablePrefix?: string }) {
    this.table = `${sanitizeIdentifier(options.tablePrefix ?? 'runtime')}_feishu_connections`;
  }

  async init(): Promise<void> {
    const client = await this.options.pool.connect();
    const lockKey = `${this.table}:init`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query('BEGIN');
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          profile_id TEXT NOT NULL,
          app_id TEXT NOT NULL,
          user_open_id TEXT NOT NULL,
          user_name TEXT,
          scope TEXT,
          connection_status TEXT NOT NULL DEFAULT 'pending',
          authenticated BOOLEAN,
          verified BOOLEAN,
          token_status TEXT,
          expires_at TIMESTAMPTZ,
          refresh_expires_at TIMESTAMPTZ,
          last_checked_at TIMESTAMPTZ,
          next_check_at TIMESTAMPTZ NOT NULL,
          last_error TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT,
          lease_until TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (tenant_id, user_id, profile_id),
          CHECK (connection_status IN ('pending', 'connected', 'error', 'disconnected'))
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.table}_due_idx
        ON ${this.table} (next_check_at)
        WHERE connection_status IN ('pending', 'connected', 'error')
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.table}_user_idx
        ON ${this.table} (tenant_id, user_id, updated_at DESC)
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

  async upsertLogin(
    identity: FeishuConnectionIdentity,
    login: FeishuLoginMetadata,
    now = new Date(),
  ): Promise<void> {
    await this.options.pool.query(`
      INSERT INTO ${this.table} (
        tenant_id, user_id, username, profile_id, app_id, user_open_id, user_name, scope,
        connection_status, authenticated, verified, next_check_at, last_error,
        consecutive_failures, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', TRUE, NULL, $9, NULL, 0, $9, $9)
      ON CONFLICT (tenant_id, user_id, profile_id) DO UPDATE SET
        username = EXCLUDED.username,
        app_id = EXCLUDED.app_id,
        user_open_id = EXCLUDED.user_open_id,
        user_name = EXCLUDED.user_name,
        scope = EXCLUDED.scope,
        connection_status = 'pending',
        authenticated = TRUE,
        verified = NULL,
        next_check_at = EXCLUDED.next_check_at,
        last_error = NULL,
        consecutive_failures = 0,
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = EXCLUDED.updated_at
    `, [
      identity.tenantId,
      identity.userId,
      identity.username,
      login.profileId,
      login.appId,
      login.userOpenId,
      nullable(login.userName),
      nullable(login.scope),
      now.toISOString(),
    ]);
  }

  async claimDue(workerId: string, now = new Date(), leaseMs = 10 * 60 * 1_000): Promise<FeishuConnectionRecord | null> {
    const result = await this.options.pool.query(`
      WITH candidate AS (
        SELECT tenant_id, user_id, profile_id
        FROM ${this.table}
        WHERE connection_status IN ('pending', 'connected', 'error')
          AND next_check_at <= $1
          AND (lease_until IS NULL OR lease_until <= $1)
        ORDER BY next_check_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${this.table} AS target
      SET lease_owner = $2, lease_until = $3, updated_at = $1
      FROM candidate
      WHERE target.tenant_id = candidate.tenant_id
        AND target.user_id = candidate.user_id
        AND target.profile_id = candidate.profile_id
      RETURNING target.*
    `, [now.toISOString(), workerId, new Date(now.getTime() + leaseMs).toISOString()]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async completeCheck(
    record: FeishuConnectionRecord,
    workerId: string,
    result: FeishuAuthCheckResult,
    now = new Date(),
  ): Promise<void> {
    const connected = result.authenticated && result.verified;
    await this.options.pool.query(`
      UPDATE ${this.table}
      SET connection_status = $5,
          authenticated = $6,
          verified = $7,
          token_status = $8,
          user_open_id = COALESCE($9, user_open_id),
          user_name = COALESCE($10, user_name),
          scope = COALESCE($11, scope),
          expires_at = COALESCE($12::timestamptz, expires_at),
          refresh_expires_at = COALESCE($13::timestamptz, refresh_expires_at),
          last_checked_at = $14,
          next_check_at = $15,
          last_error = $16,
          consecutive_failures = 0,
          lease_owner = NULL,
          lease_until = NULL,
          updated_at = $14
      WHERE tenant_id = $1 AND user_id = $2 AND profile_id = $3 AND lease_owner = $4
    `, [
      record.tenantId,
      record.userId,
      record.profileId,
      workerId,
      connected ? 'connected' : 'disconnected',
      result.authenticated,
      result.verified,
      nullable(result.tokenStatus),
      nullable(result.userOpenId),
      nullable(result.userName),
      nullable(result.scope),
      validIso(result.expiresAt) ?? null,
      validIso(result.refreshExpiresAt) ?? null,
      now.toISOString(),
      computeNextCheckAfterStatus(result, now),
      connected ? null : (result.error ?? 'not_authenticated'),
    ]);
  }

  async failCheck(record: FeishuConnectionRecord, workerId: string, error: string, now = new Date()): Promise<void> {
    await this.options.pool.query(`
      UPDATE ${this.table}
      SET connection_status = 'error', last_error = $5,
          consecutive_failures = consecutive_failures + 1,
          last_checked_at = $6, next_check_at = $7,
          lease_owner = NULL, lease_until = NULL, updated_at = $6
      WHERE tenant_id = $1 AND user_id = $2 AND profile_id = $3 AND lease_owner = $4
    `, [
      record.tenantId,
      record.userId,
      record.profileId,
      workerId,
      error.slice(0, 1_000),
      now.toISOString(),
      new Date(now.getTime() + FEISHU_RETRY_INTERVAL_MS).toISOString(),
    ]);
  }

  async releaseClaim(record: FeishuConnectionRecord, workerId: string): Promise<void> {
    await this.options.pool.query(`
      UPDATE ${this.table}
      SET lease_owner = NULL, lease_until = NULL, updated_at = NOW()
      WHERE tenant_id = $1 AND user_id = $2 AND profile_id = $3 AND lease_owner = $4
    `, [record.tenantId, record.userId, record.profileId, workerId]);
  }

  async listForUser(tenantId: string, userId: string): Promise<FeishuConnectionRecord[]> {
    const result = await this.options.pool.query(`
      SELECT * FROM ${this.table}
      WHERE tenant_id = $1 AND user_id = $2
      ORDER BY connection_status = 'connected' DESC, updated_at DESC
    `, [tenantId, userId]);
    return result.rows.map(mapRow);
  }
}

export function computeNextCheckAfterStatus(
  result: Pick<FeishuAuthCheckResult, 'refreshExpiresAt'>,
  now = new Date(),
): string {
  let dueMs = now.getTime() + FEISHU_KEEPALIVE_INTERVAL_MS;
  const refreshExpiryMs = dateMs(result.refreshExpiresAt);
  if (refreshExpiryMs > 0) dueMs = Math.min(dueMs, refreshExpiryMs - FEISHU_REFRESH_SAFETY_WINDOW_MS);
  if (dueMs <= now.getTime()) dueMs = now.getTime() + FEISHU_ACCESS_REFRESH_RETRY_MS;
  return new Date(dueMs).toISOString();
}

function mapRow(row: Record<string, unknown>): FeishuConnectionRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    username: String(row.username),
    profileId: String(row.profile_id),
    appId: String(row.app_id),
    userOpenId: String(row.user_open_id),
    ...(stringValue(row.user_name) ? { userName: stringValue(row.user_name) } : {}),
    ...(stringValue(row.scope) ? { scope: stringValue(row.scope) } : {}),
    connectionStatus: String(row.connection_status) as FeishuConnectionStatus,
    ...(typeof row.authenticated === 'boolean' ? { authenticated: row.authenticated } : {}),
    ...(typeof row.verified === 'boolean' ? { verified: row.verified } : {}),
    ...(stringValue(row.token_status) ? { tokenStatus: stringValue(row.token_status) } : {}),
    ...(isoValue(row.expires_at) ? { expiresAt: isoValue(row.expires_at) } : {}),
    ...(isoValue(row.refresh_expires_at) ? { refreshExpiresAt: isoValue(row.refresh_expires_at) } : {}),
    ...(isoValue(row.last_checked_at) ? { lastCheckedAt: isoValue(row.last_checked_at) } : {}),
    nextCheckAt: isoValue(row.next_check_at) ?? new Date(0).toISOString(),
    ...(stringValue(row.last_error) ? { lastError: stringValue(row.last_error) } : {}),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    ...(stringValue(row.lease_owner) ? { leaseOwner: stringValue(row.lease_owner) } : {}),
    ...(isoValue(row.lease_until) ? { leaseUntil: isoValue(row.lease_until) } : {}),
    createdAt: isoValue(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: isoValue(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function dateMs(value: unknown): number {
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function validIso(value: unknown): string | undefined {
  const ms = dateMs(value);
  return ms > 0 ? new Date(ms).toISOString() : undefined;
}

function isoValue(value: unknown): string | undefined {
  return validIso(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nullable(value: string | undefined): string | null {
  return value?.trim() || null;
}

function sanitizeIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid SQL identifier: ${value}`);
  return value;
}
