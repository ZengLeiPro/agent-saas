import pg from 'pg';

const { Pool } = pg;
type PgPool = pg.Pool;

/**
 * 模型图片 blob 存储。
 *
 * 背景：用户上传的图片会被规范化成 `uploads/.model-images/<sha256>-v1.<ext>`，
 * 而 `runtime_events` 只存路径引用不存像素。`uploads/` 是用户可一键清空的附件目录，
 * 清空后历史会话重放会读不到图片（2026-08-01 生产事故）。
 *
 * 这里把规范化图片同时写入一份内容寻址的 blob 副本，作为读取侧的持久事实源：
 * - 隔离键 = workspaceKey（用户 workspace 绝对路径），与原文件系统隔离语义完全一致，
 *   不引入新的跨租户可见面；
 * - 内容键 = blobKey（规范化文件名，本身含 sha256 与规范化版本），天然去重；
 * - 存二进制 bytea 而非 base64：base64 只是传输编码，读出后再编码即可，省 33% 体积。
 */
export interface ImageBlobRecord {
  mimeType: string;
  sizeBytes: number;
  bytes: Buffer;
}

export interface PutImageBlobInput {
  workspaceKey: string;
  blobKey: string;
  mimeType: string;
  bytes: Buffer;
}

export interface ImageBlobStore {
  init(): Promise<void>;
  put(input: PutImageBlobInput): Promise<void>;
  get(workspaceKey: string, blobKey: string): Promise<ImageBlobRecord | undefined>;
  close(): Promise<void>;
}

/** 与 imageAttachments 的 MAX_MODEL_IMAGE_BYTES 对齐；超限对象不入库，避免异常大行。 */
const MAX_BLOB_BYTES = 5 * 1024 * 1024;

export interface PgImageBlobStoreOptions {
  pool?: PgPool;
  connectionString?: string;
  tablePrefix?: string;
}

export class PgImageBlobStore implements ImageBlobStore {
  readonly pool: PgPool;
  readonly table: string;
  private readonly ownsPool: boolean;

  constructor(options: PgImageBlobStoreOptions) {
    if (!options.pool && !options.connectionString) {
      throw new Error('PgImageBlobStore requires either pool or connectionString');
    }
    this.table = `${sanitizeIdentifier(options.tablePrefix ?? 'runtime')}_image_blobs`;
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString! });
    this.ownsPool = !options.pool;
  }

  async init(): Promise<void> {
    await this.createIfAbsent(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        workspace_key TEXT NOT NULL,
        blob_key TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        bytes BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_key, blob_key)
      )
    `, this.table);
    await this.createIfAbsent(
      `CREATE INDEX IF NOT EXISTS ${this.table}_created_idx ON ${this.table} (created_at ASC)`,
      `${this.table}_created_idx`,
    );
  }

  /**
   * `CREATE ... IF NOT EXISTS` 在 PG 里不是原子的：蓝绿双实例同时启动时，
   * 后手会撞 23505(pg_type 唯一约束)/42P07(已存在)。此时对象已由先手建出，
   * 重查确认存在即视为成功；确认不到才是真失败。
   */
  private async createIfAbsent(sql: string, objectName: string): Promise<void> {
    try {
      await this.pool.query(sql);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== '23505' && code !== '42P07') throw error;
      const existing = await this.pool.query<{ oid: string | null }>(
        'SELECT to_regclass($1)::text AS oid',
        [objectName],
      );
      if (!existing.rows[0]?.oid) throw error;
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  async put(input: PutImageBlobInput): Promise<void> {
    if (input.bytes.byteLength > MAX_BLOB_BYTES) return;
    await this.pool.query(
      `INSERT INTO ${this.table} (workspace_key, blob_key, mime_type, size_bytes, bytes)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (workspace_key, blob_key) DO NOTHING`,
      [input.workspaceKey, input.blobKey, input.mimeType, input.bytes.byteLength, input.bytes],
    );
  }

  async get(workspaceKey: string, blobKey: string): Promise<ImageBlobRecord | undefined> {
    const result = await this.pool.query<{ mime_type: string; size_bytes: string; bytes: Buffer }>(
      `SELECT mime_type, size_bytes, bytes FROM ${this.table} WHERE workspace_key = $1 AND blob_key = $2`,
      [workspaceKey, blobKey],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), bytes: row.bytes };
  }
}

export class InMemoryImageBlobStore implements ImageBlobStore {
  private readonly blobs = new Map<string, ImageBlobRecord>();

  async init(): Promise<void> {}

  async close(): Promise<void> {
    this.blobs.clear();
  }

  async put(input: PutImageBlobInput): Promise<void> {
    if (input.bytes.byteLength > MAX_BLOB_BYTES) return;
    const key = compositeKey(input.workspaceKey, input.blobKey);
    if (this.blobs.has(key)) return;
    this.blobs.set(key, {
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      bytes: Buffer.from(input.bytes),
    });
  }

  async get(workspaceKey: string, blobKey: string): Promise<ImageBlobRecord | undefined> {
    return this.blobs.get(compositeKey(workspaceKey, blobKey));
  }
}

/**
 * 进程级单例。图片 blob 是基础设施而非请求态依赖，走单例可以避免在
 * dispatch → RawAgentLoop → adapter 三层透传一个只有图片路径才用得到的字段。
 */
let activeStore: ImageBlobStore | undefined;

export function setImageBlobStore(store: ImageBlobStore | undefined): void {
  activeStore = store;
}

export function getImageBlobStore(): ImageBlobStore | undefined {
  return activeStore;
}

function compositeKey(workspaceKey: string, blobKey: string): string {
  return `${workspaceKey}\u0000${blobKey}`;
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}
