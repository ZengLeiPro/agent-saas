import pg from 'pg';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export const DWS_KEEPALIVE_INTERVAL_MS = 21 * 24 * 60 * 60 * 1_000;
export const DWS_REFRESH_SAFETY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
export const DWS_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DWS_ACCESS_REFRESH_RETRY_MS = 3 * 60 * 60 * 1_000;

export type DwsConnectionStatus = 'pending' | 'connected' | 'error' | 'disconnected';

export interface DwsProfileMetadata {
  profileId: string;
  profileName?: string;
  corpName?: string;
  dingtalkUserId?: string;
  dingtalkUserName?: string;
  profileStatus?: string;
  expiresAt?: string;
  refreshExpiresAt?: string;
  lastLoginAt?: string;
  lastUsedAt?: string;
  updatedAt?: string;
}

export interface DwsConnectionIdentity {
  tenantId: string;
  userId: string;
  username: string;
}

export interface DwsConnectionRecord extends DwsConnectionIdentity {
  profileId: string;
  profileName?: string;
  corpName?: string;
  dingtalkUserId?: string;
  dingtalkUserName?: string;
  profileStatus?: string;
  connectionStatus: DwsConnectionStatus;
  authenticated?: boolean;
  tokenValid?: boolean;
  refreshTokenValid?: boolean;
  expiresAt?: string;
  refreshExpiresAt?: string;
  profileLastUsedAt?: string;
  profileUpdatedAt?: string;
  lastCheckedAt?: string;
  nextCheckAt: string;
  lastError?: string;
  consecutiveFailures: number;
  leaseOwner?: string;
  leaseUntil?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DwsAuthCheckResult {
  authenticated: boolean;
  tokenValid: boolean;
  refreshTokenValid: boolean;
  refreshed: boolean;
  expiresAt?: string;
  refreshExpiresAt?: string;
  corpName?: string;
  dingtalkUserId?: string;
  dingtalkUserName?: string;
  error?: string;
}

export interface DwsConnectionStore {
  syncProfiles(identity: DwsConnectionIdentity, profiles: DwsProfileMetadata[], now?: Date): Promise<void>;
  claimDue(workerId: string, now?: Date, leaseMs?: number): Promise<DwsConnectionRecord | null>;
  completeCheck(record: DwsConnectionRecord, workerId: string, result: DwsAuthCheckResult, now?: Date): Promise<void>;
  failCheck(record: DwsConnectionRecord, workerId: string, error: string, now?: Date): Promise<void>;
  releaseClaim(record: DwsConnectionRecord, workerId: string): Promise<void>;
  listForUser(tenantId: string, userId: string): Promise<DwsConnectionRecord[]>;
}

export interface PgDwsConnectionStoreOptions {
  pool: PgPool;
  tablePrefix?: string;
}

export class PgDwsConnectionStore implements DwsConnectionStore {
  readonly table: string;

  constructor(private readonly options: PgDwsConnectionStoreOptions) {
    this.table = `${sanitizeIdentifier(options.tablePrefix ?? 'runtime')}_dws_connections`;
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
          profile_name TEXT,
          corp_name TEXT,
          dingtalk_user_id TEXT,
          dingtalk_user_name TEXT,
          profile_status TEXT,
          connection_status TEXT NOT NULL DEFAULT 'pending',
          authenticated BOOLEAN,
          token_valid BOOLEAN,
          refresh_token_valid BOOLEAN,
          expires_at TIMESTAMPTZ,
          refresh_expires_at TIMESTAMPTZ,
          profile_last_used_at TIMESTAMPTZ,
          profile_updated_at TIMESTAMPTZ,
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
        WHERE connection_status IN ('pending', 'connected', 'error') AND profile_status = 'active'
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

  async syncProfiles(identity: DwsConnectionIdentity, profiles: DwsProfileMetadata[], now = new Date()): Promise<void> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const existingResult = await client.query(
        `SELECT * FROM ${this.table} WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [identity.tenantId, identity.userId],
      );
      const existing = new Map<string, DwsConnectionRecord>(
        existingResult.rows.map((row) => {
          const record = mapRow(row);
          return [record.profileId, record];
        }),
      );
      const seen = new Set<string>();

      for (const profile of profiles) {
        if (!profile.profileId || seen.has(profile.profileId)) continue;
        seen.add(profile.profileId);
        const previous = existing.get(profile.profileId);
        const profileStatus = normalizeProfileStatus(profile.profileStatus);
        const profileLastUsedAt = newestIso(profile.lastUsedAt, profile.lastLoginAt);
        const profileUpdatedAt = newestIso(profile.updatedAt, profileLastUsedAt);
        const activityAdvanced = previous
          ? dateMs(profileUpdatedAt) > Math.max(dateMs(previous.profileUpdatedAt), dateMs(previous.profileLastUsedAt))
          : false;
        const becameActive = previous?.profileStatus !== 'active' && profileStatus === 'active';
        const reconnected = Boolean(previous && previous.connectionStatus === 'disconnected' && profileStatus === 'active' && activityAdvanced);

        let connectionStatus: DwsConnectionStatus;
        let lastError = previous?.lastError;
        let consecutiveFailures = previous?.consecutiveFailures ?? 0;
        if (profileStatus === 'expired' || profileStatus === 'revoked') {
          connectionStatus = 'disconnected';
          lastError = `profile_${profileStatus}`;
        } else if (!previous) {
          connectionStatus = 'pending';
          lastError = undefined;
        } else if (becameActive || reconnected) {
          connectionStatus = 'pending';
          lastError = undefined;
          consecutiveFailures = 0;
        } else {
          connectionStatus = previous.connectionStatus;
        }

        const metadataDueAt = computeProfileDueAt(profile, now);
        const nextCheckAt = !previous || becameActive || reconnected
          ? now.toISOString()
          : activityAdvanced
            ? metadataDueAt
            : previous.nextCheckAt;

        await client.query(`
          INSERT INTO ${this.table} (
            tenant_id, user_id, username, profile_id, profile_name, corp_name,
            dingtalk_user_id, dingtalk_user_name, profile_status, connection_status,
            authenticated, token_valid, refresh_token_valid, expires_at, refresh_expires_at,
            profile_last_used_at, profile_updated_at, last_checked_at, next_check_at,
            last_error, consecutive_failures, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
            COALESCE($22::timestamptz, NOW()), $23
          )
          ON CONFLICT (tenant_id, user_id, profile_id) DO UPDATE SET
            username = EXCLUDED.username,
            profile_name = EXCLUDED.profile_name,
            corp_name = EXCLUDED.corp_name,
            dingtalk_user_id = EXCLUDED.dingtalk_user_id,
            dingtalk_user_name = EXCLUDED.dingtalk_user_name,
            profile_status = EXCLUDED.profile_status,
            connection_status = EXCLUDED.connection_status,
            expires_at = COALESCE(EXCLUDED.expires_at, ${this.table}.expires_at),
            refresh_expires_at = COALESCE(EXCLUDED.refresh_expires_at, ${this.table}.refresh_expires_at),
            profile_last_used_at = EXCLUDED.profile_last_used_at,
            profile_updated_at = EXCLUDED.profile_updated_at,
            next_check_at = EXCLUDED.next_check_at,
            last_error = EXCLUDED.last_error,
            consecutive_failures = EXCLUDED.consecutive_failures,
            updated_at = EXCLUDED.updated_at
        `, [
          identity.tenantId,
          identity.userId,
          identity.username,
          profile.profileId,
          nullable(profile.profileName),
          nullable(profile.corpName),
          nullable(profile.dingtalkUserId),
          nullable(profile.dingtalkUserName),
          profileStatus,
          connectionStatus,
          previous?.authenticated ?? null,
          previous?.tokenValid ?? null,
          previous?.refreshTokenValid ?? null,
          validIso(profile.expiresAt) ?? previous?.expiresAt ?? null,
          validIso(profile.refreshExpiresAt) ?? previous?.refreshExpiresAt ?? null,
          profileLastUsedAt ?? null,
          profileUpdatedAt ?? null,
          previous?.lastCheckedAt ?? null,
          nextCheckAt,
          lastError ?? null,
          consecutiveFailures,
          previous?.createdAt ?? null,
          now.toISOString(),
        ]);
      }

      const missing = [...existing.keys()].filter((profileId) => !seen.has(profileId));
      if (missing.length > 0) {
        await client.query(`
          UPDATE ${this.table}
          SET profile_status = 'removed', connection_status = 'disconnected',
              authenticated = FALSE, token_valid = FALSE, refresh_token_valid = FALSE,
              last_error = 'profile_removed', lease_owner = NULL, lease_until = NULL,
              updated_at = $4
          WHERE tenant_id = $1 AND user_id = $2 AND profile_id = ANY($3::text[])
        `, [identity.tenantId, identity.userId, missing, now.toISOString()]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async claimDue(workerId: string, now = new Date(), leaseMs = 10 * 60 * 1_000): Promise<DwsConnectionRecord | null> {
    const result = await this.options.pool.query(`
      WITH candidate AS (
        SELECT tenant_id, user_id, profile_id
        FROM ${this.table}
        WHERE connection_status IN ('pending', 'connected', 'error')
          AND profile_status = 'active'
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

  async completeCheck(record: DwsConnectionRecord, workerId: string, result: DwsAuthCheckResult, now = new Date()): Promise<void> {
    const connected = result.authenticated && result.refreshTokenValid;
    const nextCheckAt = computeNextCheckAfterStatus(result, now);
    await this.options.pool.query(`
      UPDATE ${this.table}
      SET connection_status = $5,
          authenticated = $6,
          token_valid = $7,
          refresh_token_valid = $8,
          expires_at = COALESCE($9::timestamptz, expires_at),
          refresh_expires_at = COALESCE($10::timestamptz, refresh_expires_at),
          corp_name = COALESCE($11, corp_name),
          dingtalk_user_id = COALESCE($12, dingtalk_user_id),
          dingtalk_user_name = COALESCE($13, dingtalk_user_name),
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
      result.tokenValid,
      result.refreshTokenValid,
      validIso(result.expiresAt) ?? null,
      validIso(result.refreshExpiresAt) ?? null,
      nullable(result.corpName),
      nullable(result.dingtalkUserId),
      nullable(result.dingtalkUserName),
      now.toISOString(),
      nextCheckAt,
      connected ? null : (result.error ?? 'not_authenticated'),
    ]);
  }

  async failCheck(record: DwsConnectionRecord, workerId: string, error: string, now = new Date()): Promise<void> {
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
      new Date(now.getTime() + DWS_RETRY_INTERVAL_MS).toISOString(),
    ]);
  }

  async releaseClaim(record: DwsConnectionRecord, workerId: string): Promise<void> {
    await this.options.pool.query(`
      UPDATE ${this.table}
      SET lease_owner = NULL, lease_until = NULL, updated_at = NOW()
      WHERE tenant_id = $1 AND user_id = $2 AND profile_id = $3 AND lease_owner = $4
    `, [record.tenantId, record.userId, record.profileId, workerId]);
  }

  async listForUser(tenantId: string, userId: string): Promise<DwsConnectionRecord[]> {
    const result = await this.options.pool.query(`
      SELECT * FROM ${this.table}
      WHERE tenant_id = $1 AND user_id = $2
      ORDER BY connection_status = 'connected' DESC, corp_name NULLS LAST, profile_id
    `, [tenantId, userId]);
    return result.rows.map(mapRow);
  }
}

export function computeProfileDueAt(profile: DwsProfileMetadata, now = new Date()): string {
  const observedActivityMs = Math.max(
    dateMs(profile.lastUsedAt),
    dateMs(profile.updatedAt),
    dateMs(profile.lastLoginAt),
  );
  const activityMs = observedActivityMs > 0 ? observedActivityMs : now.getTime();
  const candidates = [activityMs + DWS_KEEPALIVE_INTERVAL_MS];
  const refreshExpiryMs = dateMs(profile.refreshExpiresAt);
  if (refreshExpiryMs > 0) candidates.push(refreshExpiryMs - DWS_REFRESH_SAFETY_WINDOW_MS);
  return new Date(Math.max(now.getTime(), Math.min(...candidates))).toISOString();
}

export function computeNextCheckAfterStatus(result: Pick<DwsAuthCheckResult, 'refreshExpiresAt'>, now = new Date()): string {
  let dueMs = now.getTime() + DWS_KEEPALIVE_INTERVAL_MS;
  const refreshExpiryMs = dateMs(result.refreshExpiresAt);
  if (refreshExpiryMs > 0) dueMs = Math.min(dueMs, refreshExpiryMs - DWS_REFRESH_SAFETY_WINDOW_MS);
  // auth status 在 access token 尚有效时不会强制 refresh。若已经进入 7 天安全窗，
  // 等 3 小时让 2 小时 access token 自然过期，再检查即可触发正常刷新。
  if (dueMs <= now.getTime()) dueMs = now.getTime() + DWS_ACCESS_REFRESH_RETRY_MS;
  return new Date(dueMs).toISOString();
}

function mapRow(row: Record<string, unknown>): DwsConnectionRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    username: String(row.username),
    profileId: String(row.profile_id),
    ...(stringValue(row.profile_name) ? { profileName: stringValue(row.profile_name) } : {}),
    ...(stringValue(row.corp_name) ? { corpName: stringValue(row.corp_name) } : {}),
    ...(stringValue(row.dingtalk_user_id) ? { dingtalkUserId: stringValue(row.dingtalk_user_id) } : {}),
    ...(stringValue(row.dingtalk_user_name) ? { dingtalkUserName: stringValue(row.dingtalk_user_name) } : {}),
    ...(stringValue(row.profile_status) ? { profileStatus: stringValue(row.profile_status) } : {}),
    connectionStatus: String(row.connection_status) as DwsConnectionStatus,
    ...(typeof row.authenticated === 'boolean' ? { authenticated: row.authenticated } : {}),
    ...(typeof row.token_valid === 'boolean' ? { tokenValid: row.token_valid } : {}),
    ...(typeof row.refresh_token_valid === 'boolean' ? { refreshTokenValid: row.refresh_token_valid } : {}),
    ...(isoValue(row.expires_at) ? { expiresAt: isoValue(row.expires_at) } : {}),
    ...(isoValue(row.refresh_expires_at) ? { refreshExpiresAt: isoValue(row.refresh_expires_at) } : {}),
    ...(isoValue(row.profile_last_used_at) ? { profileLastUsedAt: isoValue(row.profile_last_used_at) } : {}),
    ...(isoValue(row.profile_updated_at) ? { profileUpdatedAt: isoValue(row.profile_updated_at) } : {}),
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

function normalizeProfileStatus(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized || 'active';
}

function newestIso(...values: Array<string | undefined>): string | undefined {
  const best = Math.max(...values.map(dateMs));
  return best > 0 ? new Date(best).toISOString() : undefined;
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
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function nullable(value: string | undefined): string | null {
  return value?.trim() ? value.trim() : null;
}

function sanitizeIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid SQL identifier: ${value}`);
  return value;
}
