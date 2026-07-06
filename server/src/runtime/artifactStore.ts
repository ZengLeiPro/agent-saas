import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import OSS from 'ali-oss';
import pg from 'pg';

export type ArtifactKind = 'file' | 'screenshot' | 'patch' | 'log' | 'blob';

export interface ArtifactRecord {
  artifactId: string;
  sessionId: string;
  workspaceId?: string;
  producingHandId?: string;
  kind: ArtifactKind;
  uri: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface CreateArtifactInput {
  sessionId: string;
  workspaceId?: string;
  producingHandId?: string;
  kind: ArtifactKind;
  uri: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  metadata?: Record<string, unknown>;
}

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;


export interface ArtifactBlobPutInput {
  data: string | Buffer | Uint8Array;
  contentType?: string;
  extension?: string;
  metadata?: Record<string, string>;
}

export interface ArtifactBlobObject {
  uri: string;
  sizeBytes: number;
  sha256: string;
  contentType?: string;
}

export interface ArtifactBlobStore {
  put(input: ArtifactBlobPutInput): Promise<ArtifactBlobObject>;
  get(uri: string): Promise<Buffer>;
  delete(uri: string): Promise<void>;
  createReadUrl(uri: string, opts?: { expiresInSeconds?: number }): Promise<string>;
}

export interface OssArtifactBlobStoreOptions {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
}

export class OssArtifactBlobStore implements ArtifactBlobStore {
  private readonly client: OSS;
  private readonly prefix: string;

  constructor(private readonly options: OssArtifactBlobStoreOptions) {
    const endpoint = options.endpoint?.replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.client = new OSS({
      region: options.region ?? (endpoint ? endpoint.replace(/\.aliyuncs\.com$/, '') : undefined),
      endpoint: options.endpoint,
      accessKeyId: options.accessKeyId,
      accessKeySecret: options.accessKeySecret,
      bucket: options.bucket,
    } as unknown as OSS.Options);
    this.prefix = normalizeOssPrefix(options.prefix);
  }

  async put(input: ArtifactBlobPutInput): Promise<ArtifactBlobObject> {
    const buffer = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const extension = sanitizeExtension(input.extension);
    const key = path.posix.join(this.prefix, sha256.slice(0, 2), `${sha256}${extension}`);
    const headers = input.contentType ? { 'Content-Type': input.contentType } : undefined;
    await this.client.put(key, buffer, headers ? { headers } : undefined);
    return {
      uri: `oss://${this.options.bucket}/${key}`,
      sizeBytes: buffer.byteLength,
      sha256,
      ...(input.contentType ? { contentType: input.contentType } : {}),
    };
  }

  async get(uri: string): Promise<Buffer> {
    const { key } = this.parseUri(uri);
    const result = await this.client.get(key);
    const content = (result as { content?: unknown }).content;
    if (Buffer.isBuffer(content)) return content;
    if (content instanceof Uint8Array) return Buffer.from(content);
    if (typeof content === 'string') return Buffer.from(content);
    throw new Error(`OSS artifact get returned unsupported content for ${uri}`);
  }

  async delete(uri: string): Promise<void> {
    const { key } = this.parseUri(uri);
    await this.client.delete(key).catch((err: unknown) => {
      const status = typeof err === 'object' && err && 'status' in err ? (err as { status?: unknown }).status : undefined;
      if (status !== 404) throw err;
    });
  }

  async createReadUrl(uri: string, opts: { expiresInSeconds?: number } = {}): Promise<string> {
    const { key } = this.parseUri(uri);
    return this.client.signatureUrl(key, { expires: opts.expiresInSeconds ?? 900 });
  }

  private parseUri(uri: string): { key: string } {
    const prefix = `oss://${this.options.bucket}/`;
    if (!uri.startsWith(prefix)) throw new Error(`unsupported OSS artifact uri: ${uri}`);
    const key = uri.slice(prefix.length);
    if (!key || key.includes('..') || key.startsWith('/')) {
      throw new Error(`unsafe OSS artifact uri: ${uri}`);
    }
    if (this.prefix && !key.startsWith(`${this.prefix}/`)) {
      throw new Error(`OSS artifact uri outside configured prefix: ${uri}`);
    }
    return { key };
  }
}

export interface LocalArtifactBlobStoreOptions {
  rootDir: string;
  publicBaseUrl?: string;
}

export class LocalArtifactBlobStore implements ArtifactBlobStore {
  constructor(private readonly options: LocalArtifactBlobStoreOptions) {}

  async put(input: ArtifactBlobPutInput): Promise<ArtifactBlobObject> {
    const buffer = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const extension = sanitizeExtension(input.extension);
    const relativePath = path.posix.join(sha256.slice(0, 2), `${sha256}${extension}`);
    const absolutePath = this.resolveUri(`local://${relativePath}`);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, buffer, { flag: 'wx' }).catch(async (err: unknown) => {
      if (!(err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST')) throw err;
    });
    return {
      uri: `local://${relativePath}`,
      sizeBytes: buffer.byteLength,
      sha256,
      ...(input.contentType ? { contentType: input.contentType } : {}),
    };
  }

  async get(uri: string): Promise<Buffer> {
    return fs.readFile(this.resolveUri(uri));
  }

  async delete(uri: string): Promise<void> {
    await fs.unlink(this.resolveUri(uri)).catch((err: unknown) => {
      if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')) throw err;
    });
  }

  async createReadUrl(uri: string, _opts?: { expiresInSeconds?: number }): Promise<string> {
    this.resolveUri(uri);
    if (this.options.publicBaseUrl) {
      return `${this.options.publicBaseUrl.replace(/\/$/, '')}/${encodeURI(uri.slice('local://'.length))}`;
    }
    return uri;
  }

  private resolveUri(uri: string): string {
    if (!uri.startsWith('local://')) throw new Error(`unsupported local artifact uri: ${uri}`);
    const relative = uri.slice('local://'.length);
    if (!relative || relative.includes('..') || path.isAbsolute(relative)) {
      throw new Error(`unsafe local artifact uri: ${uri}`);
    }
    const root = path.resolve(this.options.rootDir);
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(root + path.sep) && absolute !== root) {
      throw new Error(`artifact uri escapes root: ${uri}`);
    }
    return absolute;
  }
}

function sanitizeExtension(extension?: string): string {
  if (!extension) return '';
  const value = extension.startsWith('.') ? extension : `.${extension}`;
  return /^\.[a-zA-Z0-9_-]{1,16}$/.test(value) ? value : '';
}

export interface ArtifactStore {
  create(input: CreateArtifactInput): Promise<ArtifactRecord>;
  get(artifactId: string): Promise<ArtifactRecord | null>;
  listForSession(sessionId: string): Promise<ArtifactRecord[]>;
  listForSessions?(sessionIds: string[]): Promise<ArtifactRecord[]>;
  delete(artifactId: string): Promise<void>;
  listOlderThan(cutoffIso: string, limit?: number): Promise<ArtifactRecord[]>;
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, ArtifactRecord>();

  async create(input: CreateArtifactInput): Promise<ArtifactRecord> {
    const record: ArtifactRecord = {
      artifactId: `artifact_${randomUUID()}`,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      producingHandId: input.producingHandId,
      kind: input.kind,
      uri: input.uri,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      createdAt: new Date().toISOString(),
      metadata: input.metadata ?? {},
    };
    this.artifacts.set(record.artifactId, record);
    return record;
  }

  async get(artifactId: string): Promise<ArtifactRecord | null> {
    return this.artifacts.get(artifactId) ?? null;
  }

  async listForSession(sessionId: string): Promise<ArtifactRecord[]> {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listForSessions(sessionIds: string[]): Promise<ArtifactRecord[]> {
    const ids = new Set(sessionIds);
    if (ids.size === 0) return [];
    return [...this.artifacts.values()]
      .filter((artifact) => ids.has(artifact.sessionId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async delete(artifactId: string): Promise<void> {
    this.artifacts.delete(artifactId);
  }

  async listOlderThan(cutoffIso: string, limit = 100): Promise<ArtifactRecord[]> {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.createdAt < cutoffIso)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(0, limit));
  }
}

export interface PgArtifactStoreOptions {
  pool?: PgPool;
  connectionString?: string;
  tablePrefix?: string;
}

export class PgArtifactStore implements ArtifactStore {
  readonly pool: PgPool;
  readonly table: string;
  private readonly ownsPool: boolean;

  constructor(options: PgArtifactStoreOptions) {
    if (!options.pool && !options.connectionString) {
      throw new Error('PgArtifactStore requires either pool or connectionString');
    }
    this.table = `${sanitizeIdentifier(options.tablePrefix ?? 'runtime')}_artifacts`;
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString! });
    this.ownsPool = !options.pool;
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        artifact_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT,
        producing_hand_id TEXT,
        kind TEXT NOT NULL,
        uri TEXT NOT NULL,
        mime_type TEXT,
        size_bytes BIGINT,
        sha256 TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_session_idx ON ${this.table} (session_id, created_at ASC)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_workspace_idx ON ${this.table} (workspace_id) WHERE workspace_id IS NOT NULL`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_hand_idx ON ${this.table} (producing_hand_id) WHERE producing_hand_id IS NOT NULL`);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  async create(input: CreateArtifactInput): Promise<ArtifactRecord> {
    const artifactId = `artifact_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const result = await this.pool.query<ArtifactRow>(`
      INSERT INTO ${this.table}
        (artifact_id, session_id, workspace_id, producing_hand_id, kind, uri, mime_type, size_bytes, sha256, created_at, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      RETURNING *
    `, [
      artifactId,
      input.sessionId,
      input.workspaceId ?? null,
      input.producingHandId ?? null,
      input.kind,
      input.uri,
      input.mimeType ?? null,
      input.sizeBytes ?? null,
      input.sha256 ?? null,
      createdAt,
      JSON.stringify(input.metadata ?? {}),
    ]);
    return rowToArtifact(result.rows[0]!);
  }

  async get(artifactId: string): Promise<ArtifactRecord | null> {
    const result = await this.pool.query<ArtifactRow>(`SELECT * FROM ${this.table} WHERE artifact_id = $1`, [artifactId]);
    return result.rows[0] ? rowToArtifact(result.rows[0]) : null;
  }

  async listForSession(sessionId: string): Promise<ArtifactRecord[]> {
    const result = await this.pool.query<ArtifactRow>(
      `SELECT * FROM ${this.table} WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId],
    );
    return result.rows.map(rowToArtifact);
  }

  async listForSessions(sessionIds: string[]): Promise<ArtifactRecord[]> {
    if (sessionIds.length === 0) return [];
    const result = await this.pool.query<ArtifactRow>(
      `SELECT * FROM ${this.table} WHERE session_id = ANY($1::text[]) ORDER BY created_at ASC`,
      [sessionIds],
    );
    return result.rows.map(rowToArtifact);
  }

  async delete(artifactId: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.table} WHERE artifact_id = $1`, [artifactId]);
  }

  async listOlderThan(cutoffIso: string, limit = 100): Promise<ArtifactRecord[]> {
    const result = await this.pool.query<ArtifactRow>(
      `SELECT * FROM ${this.table} WHERE created_at < $1 ORDER BY created_at ASC LIMIT $2`,
      [cutoffIso, Math.min(Math.max(limit, 1), 1000)],
    );
    return result.rows.map(rowToArtifact);
  }
}

interface ArtifactRow {
  artifact_id: string;
  session_id: string;
  workspace_id: string | null;
  producing_hand_id: string | null;
  kind: ArtifactKind;
  uri: string;
  mime_type: string | null;
  size_bytes: string | number | null;
  sha256: string | null;
  created_at: Date | string;
  metadata: Record<string, unknown> | string;
}

function rowToArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    artifactId: row.artifact_id,
    sessionId: row.session_id,
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.producing_hand_id ? { producingHandId: row.producing_hand_id } : {}),
    kind: row.kind,
    uri: row.uri,
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    ...(row.size_bytes !== null && row.size_bytes !== undefined ? { sizeBytes: Number(row.size_bytes) } : {}),
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) as Record<string, unknown> : row.metadata,
  };
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}

function normalizeOssPrefix(prefix?: string): string {
  if (!prefix) return 'artifacts';
  const value = prefix.replace(/^\/+|\/+$/g, '');
  if (!value || value.includes('..')) throw new Error(`unsafe OSS artifact prefix: ${prefix}`);
  return value;
}
