import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export interface ArtifactShareRecord {
  shareId: string;
  artifactId: string;
  sessionId: string;
  tenantId: string;
  ownerUserId: string;
  createdByUserId: string;
  tokenHash: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  revokedAt?: string;
  allowDownload: boolean;
  accessCount: number;
  lastAccessedAt?: string;
}

export interface UpsertArtifactShareInput {
  shareId: string;
  artifactId: string;
  sessionId: string;
  tenantId: string;
  ownerUserId: string;
  createdByUserId: string;
  tokenHash: string;
  expiresAt: string;
  allowDownload: boolean;
}

export interface ArtifactShareStore {
  close?(): Promise<void>;
  getCurrent(artifactId: string, ownerUserId: string): Promise<ArtifactShareRecord | null>;
  upsertCurrent(input: UpsertArtifactShareInput): Promise<ArtifactShareRecord>;
  getByTokenHash(tokenHash: string): Promise<ArtifactShareRecord | null>;
  markAccessed(shareId: string): Promise<ArtifactShareRecord | null>;
  revoke(artifactId: string, ownerUserId: string): Promise<boolean>;
  revokeBySession(sessionId: string, ownerUserId: string): Promise<number>;
  isArtifactPinned(artifactId: string): Promise<boolean>;
  withArtifactLock<T>(artifactId: string, operation: () => Promise<T>): Promise<T>;
  withBlobLock<T>(uri: string, operation: () => Promise<T>): Promise<T>;
  withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  withArtifactSessionLock<T>(artifactId: string, sessionId: string, operation: () => Promise<T>): Promise<T>;
}

export class InMemoryArtifactShareStore implements ArtifactShareStore {
  private readonly records = new Map<string, ArtifactShareRecord>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async getCurrent(artifactId: string, ownerUserId: string): Promise<ArtifactShareRecord | null> {
    const now = this.now().getTime();
    const record = [...this.records.values()]
      .filter(item => item.artifactId === artifactId && item.ownerUserId === ownerUserId)
      .filter(item => !item.revokedAt && Date.parse(item.expiresAt) > now)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return record ? cloneRecord(record) : null;
  }

  async upsertCurrent(input: UpsertArtifactShareInput): Promise<ArtifactShareRecord> {
    const now = this.now().toISOString();
    const existing = await this.getCurrent(input.artifactId, input.ownerUserId);
    if (existing) {
      const updated: ArtifactShareRecord = {
        ...existing,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        createdByUserId: input.createdByUserId,
        expiresAt: input.expiresAt,
        allowDownload: input.allowDownload,
        updatedAt: now,
      };
      this.records.set(existing.shareId, updated);
      return cloneRecord(updated);
    }
    for (const record of this.records.values()) {
      if (record.artifactId === input.artifactId && record.ownerUserId === input.ownerUserId && !record.revokedAt) {
        record.revokedAt = now;
        record.updatedAt = now;
      }
    }
    const created: ArtifactShareRecord = {
      shareId: input.shareId || randomUUID(),
      artifactId: input.artifactId,
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      ownerUserId: input.ownerUserId,
      createdByUserId: input.createdByUserId,
      tokenHash: input.tokenHash,
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
      allowDownload: input.allowDownload,
      accessCount: 0,
    };
    this.records.set(created.shareId, created);
    return cloneRecord(created);
  }

  async getByTokenHash(tokenHash: string): Promise<ArtifactShareRecord | null> {
    const record = [...this.records.values()].find(item => item.tokenHash === tokenHash);
    return record ? cloneRecord(record) : null;
  }

  async markAccessed(shareId: string): Promise<ArtifactShareRecord | null> {
    const record = this.records.get(shareId);
    if (!record || record.revokedAt || Date.parse(record.expiresAt) <= this.now().getTime()) return null;
    record.accessCount += 1;
    record.lastAccessedAt = this.now().toISOString();
    return cloneRecord(record);
  }

  async revoke(artifactId: string, ownerUserId: string): Promise<boolean> {
    const now = this.now().toISOString();
    let changed = false;
    for (const record of this.records.values()) {
      if (record.artifactId === artifactId && record.ownerUserId === ownerUserId && !record.revokedAt) {
        record.revokedAt = now;
        record.updatedAt = now;
        changed = true;
      }
    }
    return changed;
  }

  async revokeBySession(sessionId: string, ownerUserId: string): Promise<number> {
    const now = this.now().toISOString();
    let changed = 0;
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId && record.ownerUserId === ownerUserId && !record.revokedAt) {
        record.revokedAt = now;
        record.updatedAt = now;
        changed += 1;
      }
    }
    return changed;
  }

  async isArtifactPinned(artifactId: string): Promise<boolean> {
    const now = this.now().getTime();
    return [...this.records.values()].some(record =>
      record.artifactId === artifactId && !record.revokedAt && Date.parse(record.expiresAt) > now,
    );
  }

  withArtifactLock<T>(artifactId: string, operation: () => Promise<T>): Promise<T> {
    return this.withLocks([`artifact:${artifactId}`], operation);
  }

  withBlobLock<T>(uri: string, operation: () => Promise<T>): Promise<T> {
    return this.withLocks([`blob:${uri}`], operation);
  }

  withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.withLocks([`session:${sessionId}`], operation);
  }

  withArtifactSessionLock<T>(artifactId: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.withLocks([`artifact:${artifactId}`, `session:${sessionId}`], operation);
  }

  private async withLocks<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const acquire = async (index: number): Promise<T> => {
      if (index >= ordered.length) return operation();
      const key = ordered[index]!;
      const previous = this.locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>(resolve => { release = resolve; });
      const queued = previous.then(() => current);
      this.locks.set(key, queued);
      await previous;
      try {
        return await acquire(index + 1);
      } finally {
        release();
        if (this.locks.get(key) === queued) this.locks.delete(key);
      }
    };
    return acquire(0);
  }
}

export interface PgArtifactShareStoreOptions {
  pool?: PgPool;
  /** Dedicated pool for advisory locks; production normally derives it from connectionString. */
  lockPool?: PgPool;
  connectionString?: string;
  tablePrefix?: string;
}

export class PgArtifactShareStore implements ArtifactShareStore {
  readonly pool: PgPool;
  readonly table: string;
  readonly artifactTable: string;
  private readonly ownsPool: boolean;
  private readonly lockPool: PgPool;
  private readonly ownsLockPool: boolean;

  constructor(options: PgArtifactShareStoreOptions) {
    if (!options.pool && !options.connectionString) {
      throw new Error('PgArtifactShareStore requires either pool or connectionString');
    }
    if (options.pool && !options.lockPool && !options.connectionString) {
      throw new Error('PgArtifactShareStore requires connectionString or a dedicated lockPool when pool is shared');
    }
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.table = `${prefix}_artifact_shares`;
    this.artifactTable = `${prefix}_artifacts`;
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString! });
    this.ownsPool = !options.pool;
    this.lockPool = options.lockPool
      ?? (options.connectionString ? new Pool({ connectionString: options.connectionString, max: 1 }) : this.pool);
    this.ownsLockPool = !options.lockPool && !!options.connectionString;
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        share_id UUID PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        allow_download BOOLEAN NOT NULL DEFAULT FALSE,
        access_count BIGINT NOT NULL DEFAULT 0,
        last_accessed_at TIMESTAMPTZ
      )
    `);
    await this.pool.query(`
      DO $$ BEGIN
        ALTER TABLE ${this.table}
          ADD CONSTRAINT ${this.table}_artifact_fk
          FOREIGN KEY (artifact_id) REFERENCES ${this.artifactTable}(artifact_id) ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_artifact_idx ON ${this.table} (artifact_id, owner_user_id)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_session_idx ON ${this.table} (session_id, owner_user_id)`);
    await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${this.table}_active_uidx ON ${this.table} (artifact_id, owner_user_id) WHERE revoked_at IS NULL`);
  }

  async close(): Promise<void> {
    if (this.ownsLockPool && this.lockPool !== this.pool) await this.lockPool.end();
    if (this.ownsPool) await this.pool.end();
  }

  async getCurrent(artifactId: string, ownerUserId: string): Promise<ArtifactShareRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.table}
       WHERE artifact_id=$1 AND owner_user_id=$2 AND revoked_at IS NULL AND expires_at > now()
       ORDER BY updated_at DESC LIMIT 1`,
      [artifactId, ownerUserId],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async upsertCurrent(input: UpsertArtifactShareInput): Promise<ArtifactShareRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ${this.table} SET revoked_at=COALESCE(revoked_at,now()),updated_at=now()
         WHERE artifact_id=$1 AND owner_user_id=$2 AND revoked_at IS NULL AND expires_at <= now()`,
        [input.artifactId, input.ownerUserId],
      );
      const existing = await client.query(
        `SELECT * FROM ${this.table}
         WHERE artifact_id=$1 AND owner_user_id=$2 AND revoked_at IS NULL AND expires_at > now()
         ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
        [input.artifactId, input.ownerUserId],
      );
      const result = existing.rows[0]
        ? await client.query(
            `UPDATE ${this.table}
             SET session_id=$2,tenant_id=$3,created_by_user_id=$4,expires_at=$5,allow_download=$6,updated_at=now()
             WHERE share_id=$1 RETURNING *`,
            [existing.rows[0].share_id, input.sessionId, input.tenantId, input.createdByUserId, input.expiresAt, input.allowDownload],
          )
        : await client.query(
            `INSERT INTO ${this.table}
             (share_id,artifact_id,session_id,tenant_id,owner_user_id,created_by_user_id,token_hash,expires_at,allow_download)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [input.shareId, input.artifactId, input.sessionId, input.tenantId, input.ownerUserId, input.createdByUserId, input.tokenHash, input.expiresAt, input.allowDownload],
          );
      await client.query('COMMIT');
      return rowToRecord(result.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getByTokenHash(tokenHash: string): Promise<ArtifactShareRecord | null> {
    const result = await this.pool.query(`SELECT * FROM ${this.table} WHERE token_hash=$1 LIMIT 1`, [tokenHash]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async markAccessed(shareId: string): Promise<ArtifactShareRecord | null> {
    const result = await this.pool.query(
      `UPDATE ${this.table} SET access_count=access_count+1,last_accessed_at=now()
       WHERE share_id=$1 AND revoked_at IS NULL AND expires_at > now() RETURNING *`,
      [shareId],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async revoke(artifactId: string, ownerUserId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${this.table} SET revoked_at=COALESCE(revoked_at,now()),updated_at=now()
       WHERE artifact_id=$1 AND owner_user_id=$2 AND revoked_at IS NULL`,
      [artifactId, ownerUserId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async revokeBySession(sessionId: string, ownerUserId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ${this.table} SET revoked_at=COALESCE(revoked_at,now()),updated_at=now()
       WHERE session_id=$1 AND owner_user_id=$2 AND revoked_at IS NULL`,
      [sessionId, ownerUserId],
    );
    return result.rowCount ?? 0;
  }

  async isArtifactPinned(artifactId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM ${this.table}
       WHERE artifact_id=$1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1`,
      [artifactId],
    );
    return !!result.rows[0];
  }

  withArtifactLock<T>(artifactId: string, operation: () => Promise<T>): Promise<T> {
    return this.withLocks([`artifact:${artifactId}`], operation);
  }

  withBlobLock<T>(uri: string, operation: () => Promise<T>): Promise<T> {
    return this.withLocks([`blob:${uri}`], operation);
  }

  withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.withLocks([`session:${sessionId}`], operation);
  }

  withArtifactSessionLock<T>(artifactId: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.withLocks([`artifact:${artifactId}`, `session:${sessionId}`], operation);
  }

  private async withLocks<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
    // 同一事务按稳定顺序获取全部 advisory locks，既避免多进程竞态，也避免
    // lockPool max=1 时通过嵌套调用等待自己持有的唯一连接。
    let client: PoolClient | undefined;
    try {
      client = await this.lockPool.connect();
      await client.query('BEGIN');
      for (const key of [...new Set(keys)].sort()) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`artifact-share:${key}`]);
      }
      const result = await operation();
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client?.release();
    }
  }
}

function rowToRecord(row: Record<string, unknown>): ArtifactShareRecord {
  return {
    shareId: String(row.share_id),
    artifactId: String(row.artifact_id),
    sessionId: String(row.session_id),
    tenantId: String(row.tenant_id),
    ownerUserId: String(row.owner_user_id),
    createdByUserId: String(row.created_by_user_id),
    tokenHash: String(row.token_hash),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    expiresAt: toIso(row.expires_at),
    ...(row.revoked_at ? { revokedAt: toIso(row.revoked_at) } : {}),
    allowDownload: row.allow_download === true,
    accessCount: Number(row.access_count ?? 0),
    ...(row.last_accessed_at ? { lastAccessedAt: toIso(row.last_accessed_at) } : {}),
  };
}

function cloneRecord(record: ArtifactShareRecord): ArtifactShareRecord {
  return { ...record };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  }
  return value;
}
