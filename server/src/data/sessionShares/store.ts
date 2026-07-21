import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

import type { ParsedTranscript } from '../transcripts/parse.js';
import { COMPROMISED_LEGACY_SESSION_SHARE_TOKEN_HASHES } from './compromisedTokenHashes.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export interface SessionShareSnapshot {
  sessionId: string;
  stats: ParsedTranscript['stats'];
  blocks: ParsedTranscript['blocks'];
  owner?: {
    userId: string;
    username: string;
    realName?: string;
    avatar?: string;
    avatarVersion?: number;
  };
  source?: { type: string; label: string };
  lastRunState?: {
    runId: string;
    status: string;
    error?: string;
    finishedAt?: string;
  };
  allowedFiles?: Array<{
    relativePath: string;
    fileName: string;
    sha256?: string;
    bytes?: number;
    contentType?: string;
    contentBase64?: string;
  }>;
}

export interface SessionShareRecord {
  shareId: string;
  token: string;
  sessionId: string;
  tenantId: string;
  ownerUserId: string;
  ownerUsername: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  revokedAt?: string;
  debugMode: boolean;
  snapshot: SessionShareSnapshot;
  accessCount: number;
  lastAccessedAt?: string;
}

export interface UpsertSessionShareInput {
  sessionId: string;
  tenantId: string;
  ownerUserId: string;
  ownerUsername: string;
  createdByUserId: string;
  debugMode: boolean;
  snapshot: SessionShareSnapshot;
  expiresAt?: string;
}

export interface SessionShareStore {
  getActiveBySession(sessionId: string, ownerUserId: string): Promise<SessionShareRecord | null>;
  upsertActive(input: UpsertSessionShareInput): Promise<SessionShareRecord>;
  getByToken(token: string): Promise<SessionShareRecord | null>;
  markAccessed(shareId: string): Promise<void>;
  revokeBySession(sessionId: string, ownerUserId: string): Promise<boolean>;
}

export function createShareToken(): string {
  return randomBytes(24).toString('base64url');
}

export function isShareExpired(record: Pick<SessionShareRecord, 'expiresAt'>, now = new Date()): boolean {
  return Boolean(record.expiresAt && Date.parse(record.expiresAt) <= now.getTime());
}

// PostgreSQL jsonb 不支持 U+0000；分享快照可能包含带 NUL 的工具输出。
// 在持久化边界转成可见转义文本，同时保留原本的字面量 `\u0000`。
function serializeSnapshotForJsonb(snapshot: SessionShareSnapshot): string {
  const serialized = JSON.stringify(snapshot, (_key, value) => (
    typeof value === 'string' && value.includes('\u0000')
      ? value.replaceAll('\u0000', '\\u0000')
      : value
  ));
  if (serialized === undefined) throw new Error('session share snapshot 无法序列化为 JSON');
  return serialized;
}

export class InMemorySessionShareStore implements SessionShareStore {
  private readonly records = new Map<string, SessionShareRecord>();

  async getActiveBySession(sessionId: string, ownerUserId: string): Promise<SessionShareRecord | null> {
    for (const record of this.records.values()) {
      if (
        record.sessionId === sessionId &&
        record.ownerUserId === ownerUserId &&
        !record.revokedAt &&
        !isShareExpired(record)
      ) {
        return cloneRecord(record);
      }
    }
    return null;
  }

  async upsertActive(input: UpsertSessionShareInput): Promise<SessionShareRecord> {
    const existing = await this.getActiveBySession(input.sessionId, input.ownerUserId);
    const now = new Date().toISOString();
    if (existing) {
      const next: SessionShareRecord = {
        ...existing,
        tenantId: input.tenantId,
        ownerUsername: input.ownerUsername,
        createdByUserId: input.createdByUserId,
        updatedAt: now,
        debugMode: input.debugMode,
        snapshot: input.snapshot,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      };
      this.records.set(next.shareId, cloneRecord(next));
      return cloneRecord(next);
    }

    const record: SessionShareRecord = {
      shareId: randomUUID(),
      token: createShareToken(),
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      ownerUserId: input.ownerUserId,
      ownerUsername: input.ownerUsername,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      debugMode: input.debugMode,
      snapshot: input.snapshot,
      accessCount: 0,
    };
    this.records.set(record.shareId, cloneRecord(record));
    return cloneRecord(record);
  }

  async getByToken(token: string): Promise<SessionShareRecord | null> {
    if (COMPROMISED_LEGACY_SESSION_SHARE_TOKEN_HASHES.has(hashShareToken(token))) return null;
    for (const record of this.records.values()) {
      if (record.token === token) return cloneRecord(record);
    }
    return null;
  }

  async markAccessed(shareId: string): Promise<void> {
    const record = this.records.get(shareId);
    if (!record) return;
    record.accessCount += 1;
    record.lastAccessedAt = new Date().toISOString();
  }

  async revokeBySession(sessionId: string, ownerUserId: string): Promise<boolean> {
    const now = new Date().toISOString();
    let changed = false;
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId && record.ownerUserId === ownerUserId && !record.revokedAt) {
        record.revokedAt = now;
        record.updatedAt = now;
        changed = true;
      }
    }
    return changed;
  }
}

export interface PgSessionShareStoreOptions {
  pool?: PgPool;
  connectionString?: string;
  tablePrefix?: string;
}

export class PgSessionShareStore implements SessionShareStore {
  readonly pool: PgPool;
  readonly sharesTable: string;
  private readonly ownsPool: boolean;

  constructor(options: PgSessionShareStoreOptions) {
    if (!options.pool && !options.connectionString) {
      throw new Error('PgSessionShareStore requires either pool or connectionString');
    }
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.sharesTable = `${prefix}_session_shares`;
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString! });
    this.ownsPool = !options.pool;
  }

  async init(): Promise<void> {
    const lockKey = `${this.sharesTable}:init`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.sharesTable} (
          share_id TEXT PRIMARY KEY,
          token TEXT UNIQUE NOT NULL,
          token_hash TEXT,
          session_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          owner_username TEXT NOT NULL,
          created_by_user_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ,
          revoked_at TIMESTAMPTZ,
          debug_mode BOOLEAN NOT NULL DEFAULT FALSE,
          snapshot_json JSONB NOT NULL,
          access_count INTEGER NOT NULL DEFAULT 0,
          last_accessed_at TIMESTAMPTZ
        )
      `);
      await client.query(`ALTER TABLE ${this.sharesTable} ADD COLUMN IF NOT EXISTS token_hash TEXT`);
      const legacyTokens = await client.query(
        `SELECT share_id, token, token_hash
         FROM ${this.sharesTable}
         WHERE token_hash IS NULL
            OR (revoked_at IS NULL AND token_hash = ANY($1::text[]))`,
        [[...COMPROMISED_LEGACY_SESSION_SHARE_TOKEN_HASHES]],
      );
      for (const row of legacyTokens.rows) {
        const tokenHash = row.token_hash ? String(row.token_hash) : hashShareToken(String(row.token));
        await client.query(
          `UPDATE ${this.sharesTable}
           SET token_hash=COALESCE(token_hash,$2),
               revoked_at=CASE WHEN $3 THEN COALESCE(revoked_at,now()) ELSE revoked_at END,
               updated_at=CASE WHEN $3 THEN now() ELSE updated_at END
           WHERE share_id=$1`,
          [
            String(row.share_id),
            tokenHash,
            COMPROMISED_LEGACY_SESSION_SHARE_TOKEN_HASHES.has(tokenHash),
          ],
        );
      }
      await client.query(`UPDATE ${this.sharesTable} SET revoked_at=COALESCE(revoked_at,now()),updated_at=now() WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now()`);
      await client.query(`
        WITH ranked AS (
          SELECT share_id,
                 row_number() OVER (PARTITION BY session_id, owner_user_id ORDER BY updated_at DESC, share_id DESC) AS rank
          FROM ${this.sharesTable}
          WHERE revoked_at IS NULL
        )
        UPDATE ${this.sharesTable} shares
        SET revoked_at=now(),updated_at=now()
        FROM ranked
        WHERE shares.share_id=ranked.share_id AND ranked.rank > 1
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.sharesTable}_session_idx ON ${this.sharesTable} (session_id, owner_user_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.sharesTable}_tenant_idx ON ${this.sharesTable} (tenant_id, updated_at DESC)`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${this.sharesTable}_active_uidx ON ${this.sharesTable} (session_id, owner_user_id) WHERE revoked_at IS NULL`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${this.sharesTable}_token_hash_uidx ON ${this.sharesTable} (token_hash) WHERE token_hash IS NOT NULL`);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  async getActiveBySession(sessionId: string, ownerUserId: string): Promise<SessionShareRecord | null> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.sharesTable}
        WHERE session_id = $1
          AND owner_user_id = $2
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [sessionId, ownerUserId],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async upsertActive(input: UpsertSessionShareInput): Promise<SessionShareRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `session-share:${input.sessionId}:${input.ownerUserId}`,
      ]);
      await client.query(
        `UPDATE ${this.sharesTable}
         SET revoked_at=COALESCE(revoked_at,now()),updated_at=now()
         WHERE session_id=$1 AND owner_user_id=$2 AND revoked_at IS NULL
           AND expires_at IS NOT NULL AND expires_at <= now()`,
        [input.sessionId, input.ownerUserId],
      );
      const existing = await client.query(
        `
          SELECT *
          FROM ${this.sharesTable}
          WHERE session_id = $1
            AND owner_user_id = $2
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())
          ORDER BY updated_at DESC
          LIMIT 1
          FOR UPDATE
        `,
        [input.sessionId, input.ownerUserId],
      );

      let record: SessionShareRecord;
      if (existing.rows[0]) {
        const updated = await client.query(
          `
            UPDATE ${this.sharesTable}
            SET tenant_id = $2,
                owner_username = $3,
                created_by_user_id = $4,
                updated_at = now(),
                expires_at = $5,
                debug_mode = $6,
                snapshot_json = $7
            WHERE share_id = $1
            RETURNING *
          `,
          [
            existing.rows[0].share_id,
            input.tenantId,
            input.ownerUsername,
            input.createdByUserId,
            input.expiresAt ?? null,
            input.debugMode,
            serializeSnapshotForJsonb(input.snapshot),
          ],
        );
        record = rowToRecord(updated.rows[0]);
      } else {
        const inserted = await client.query(
          `
            INSERT INTO ${this.sharesTable}
              (share_id, token, token_hash, session_id, tenant_id, owner_user_id, owner_username,
               created_by_user_id, created_at, updated_at, expires_at, debug_mode, snapshot_json)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now(), $9, $10, $11)
            RETURNING *
          `,
          (() => {
            const token = createShareToken();
            return [
              randomUUID(),
              token,
              hashShareToken(token),
              input.sessionId,
              input.tenantId,
              input.ownerUserId,
              input.ownerUsername,
              input.createdByUserId,
              input.expiresAt ?? null,
              input.debugMode,
              serializeSnapshotForJsonb(input.snapshot),
            ];
          })(),
        );
        record = rowToRecord(inserted.rows[0]);
      }

      await client.query('COMMIT');
      return record;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getByToken(token: string): Promise<SessionShareRecord | null> {
    const tokenHash = hashShareToken(token);
    if (COMPROMISED_LEGACY_SESSION_SHARE_TOKEN_HASHES.has(tokenHash)) return null;
    const result = await this.pool.query(
      `SELECT *
       FROM ${this.sharesTable}
       WHERE token_hash = $1
          OR (token_hash IS NULL AND token = $2)
       LIMIT 1`,
      [tokenHash, token],
    );
    if (!result.rows[0]) return null;

    // 蓝绿发布期间，N 版本仍可能写入没有 token_hash 的记录。新版本兼容读取，
    // 并在命中时幂等补齐 hash；plaintext 列需待 N+1 contract 阶段再移除。
    if (!result.rows[0].token_hash) {
      await this.pool.query(
        `UPDATE ${this.sharesTable}
         SET token_hash = $2
         WHERE share_id = $1 AND token_hash IS NULL`,
        [result.rows[0].share_id, tokenHash],
      );
    }
    return rowToRecord(result.rows[0]);
  }

  async markAccessed(shareId: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE ${this.sharesTable}
        SET access_count = access_count + 1,
            last_accessed_at = now()
        WHERE share_id = $1
      `,
      [shareId],
    );
  }

  async revokeBySession(sessionId: string, ownerUserId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE ${this.sharesTable}
        SET revoked_at = COALESCE(revoked_at, now()),
            updated_at = now()
        WHERE session_id = $1
          AND owner_user_id = $2
          AND revoked_at IS NULL
      `,
      [sessionId, ownerUserId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

function rowToRecord(row: Record<string, unknown>): SessionShareRecord {
  return {
    shareId: String(row.share_id),
    token: String(row.token),
    sessionId: String(row.session_id),
    tenantId: String(row.tenant_id),
    ownerUserId: String(row.owner_user_id),
    ownerUsername: String(row.owner_username),
    createdByUserId: String(row.created_by_user_id),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    ...(row.expires_at ? { expiresAt: toIso(row.expires_at) } : {}),
    ...(row.revoked_at ? { revokedAt: toIso(row.revoked_at) } : {}),
    debugMode: row.debug_mode === true,
    snapshot: row.snapshot_json as SessionShareSnapshot,
    accessCount: Number(row.access_count ?? 0),
    ...(row.last_accessed_at ? { lastAccessedAt: toIso(row.last_accessed_at) } : {}),
  };
}

function cloneRecord(record: SessionShareRecord): SessionShareRecord {
  return JSON.parse(JSON.stringify(record)) as SessionShareRecord;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date(String(value)).toISOString();
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  }
  return value;
}

function hashShareToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
