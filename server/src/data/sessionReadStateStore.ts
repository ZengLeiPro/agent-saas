import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Pool } from 'pg';

const DEFAULT_TABLE_NAME = 'runtime_session_read_states';

export interface SessionReadStateStore {
  init(): Promise<void>;
  markUnread(input: {
    tenantId: string;
    userId: string;
    sessionId: string;
    eventKey: string;
  }): Promise<boolean>;
  markRead(input: {
    tenantId: string;
    userId: string;
    sessionId: string;
  }): Promise<boolean>;
  listUnreadSessionIds(input: {
    tenantId: string;
    userId: string;
    sessionIds: readonly string[];
  }): Promise<Set<string>>;
}

export class PgSessionReadStateStore implements SessionReadStateStore {
  private readonly tableName: string;

  constructor(private readonly pool: Pool, options: { tableName?: string } = {}) {
    this.tableName = validateIdentifier(options.tableName ?? DEFAULT_TABLE_NAME);
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        attention_version BIGINT NOT NULL DEFAULT 0,
        read_version BIGINT NOT NULL DEFAULT 0,
        last_attention_event_key TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, user_id, session_id)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${this.tableName}_unread_idx
      ON ${this.tableName} (tenant_id, user_id)
      WHERE attention_version > read_version
    `);
  }

  async markUnread(input: {
    tenantId: string;
    userId: string;
    sessionId: string;
    eventKey: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO ${this.tableName}
         (tenant_id, user_id, session_id, attention_version, read_version, last_attention_event_key, updated_at)
       VALUES ($1, $2, $3, 1, 0, $4, NOW())
       ON CONFLICT (tenant_id, user_id, session_id) DO UPDATE SET
         attention_version = ${this.tableName}.attention_version + 1,
         last_attention_event_key = EXCLUDED.last_attention_event_key,
         updated_at = NOW()
       WHERE ${this.tableName}.last_attention_event_key IS DISTINCT FROM EXCLUDED.last_attention_event_key
       RETURNING attention_version > read_version AS has_unread`,
      [input.tenantId, input.userId, input.sessionId, input.eventKey],
    );
    return result.rowCount === 1;
  }

  async markRead(input: {
    tenantId: string;
    userId: string;
    sessionId: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO ${this.tableName}
         (tenant_id, user_id, session_id, attention_version, read_version, updated_at)
       VALUES ($1, $2, $3, 0, 0, NOW())
       ON CONFLICT (tenant_id, user_id, session_id) DO UPDATE SET
         read_version = ${this.tableName}.attention_version,
         updated_at = NOW()
       WHERE ${this.tableName}.read_version < ${this.tableName}.attention_version
       RETURNING attention_version > read_version AS has_unread`,
      [input.tenantId, input.userId, input.sessionId],
    );
    return result.rowCount === 1;
  }

  async listUnreadSessionIds(input: {
    tenantId: string;
    userId: string;
    sessionIds: readonly string[];
  }): Promise<Set<string>> {
    if (input.sessionIds.length === 0) return new Set();
    const result = await this.pool.query<{ session_id: string }>(
      `SELECT session_id
       FROM ${this.tableName}
       WHERE tenant_id = $1
         AND user_id = $2
         AND session_id = ANY($3::text[])
         AND attention_version > read_version`,
      [input.tenantId, input.userId, [...input.sessionIds]],
    );
    return new Set(result.rows.map((row) => row.session_id));
  }
}

interface FileReadStateRecord {
  attentionVersion: number;
  readVersion: number;
  lastAttentionEventKey?: string;
}

type FileReadStateData = Record<string, FileReadStateRecord>;

export class FileSessionReadStateStore implements SessionReadStateStore {
  private data: FileReadStateData = {};
  private writeQueue = Promise.resolve();
  private readonly lockPath: string;

  constructor(private readonly filePath: string) {
    this.lockPath = `${filePath}.lock`;
  }

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf-8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed as FileReadStateData;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async markUnread(input: {
    tenantId: string;
    userId: string;
    sessionId: string;
    eventKey: string;
  }): Promise<boolean> {
    return this.mutate(() => {
      const key = stateKey(input.tenantId, input.userId, input.sessionId);
      const current = this.data[key] ?? { attentionVersion: 0, readVersion: 0 };
      if (current.lastAttentionEventKey === input.eventKey) return false;
      this.data[key] = {
        ...current,
        attentionVersion: current.attentionVersion + 1,
        lastAttentionEventKey: input.eventKey,
      };
      return true;
    });
  }

  async markRead(input: {
    tenantId: string;
    userId: string;
    sessionId: string;
  }): Promise<boolean> {
    return this.mutate(() => {
      const key = stateKey(input.tenantId, input.userId, input.sessionId);
      const current = this.data[key] ?? { attentionVersion: 0, readVersion: 0 };
      if (current.readVersion >= current.attentionVersion) return false;
      this.data[key] = { ...current, readVersion: current.attentionVersion };
      return true;
    });
  }

  async listUnreadSessionIds(input: {
    tenantId: string;
    userId: string;
    sessionIds: readonly string[];
  }): Promise<Set<string>> {
    await this.writeQueue;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf-8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed as FileReadStateData;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const unread = new Set<string>();
    for (const sessionId of input.sessionIds) {
      const current = this.data[stateKey(input.tenantId, input.userId, sessionId)];
      if (current && current.attentionVersion > current.readVersion) unread.add(sessionId);
    }
    return unread;
  }

  private async mutate(change: () => boolean): Promise<boolean> {
    let changed = false;
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const release = await this.acquireLock();
      try {
        try {
          const parsed = JSON.parse(await readFile(this.filePath, 'utf-8')) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            this.data = parsed as FileReadStateData;
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          this.data = {};
        }
        changed = change();
        if (!changed) return;
        const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tempPath, JSON.stringify(this.data), 'utf-8');
        await rename(tempPath, this.filePath);
      } finally {
        await release();
      }
    });
    await this.writeQueue;
    return changed;
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    for (;;) {
      try {
        const handle = await open(this.lockPath, 'wx');
        return async () => {
          await handle.close();
          await unlink(this.lockPath).catch(() => {});
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
}

function stateKey(tenantId: string, userId: string, sessionId: string): string {
  return `${tenantId}\u0000${userId}\u0000${sessionId}`;
}

function validateIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  }
  return value;
}
