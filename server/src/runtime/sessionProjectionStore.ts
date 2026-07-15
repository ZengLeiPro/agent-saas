import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

import pg from 'pg';

import type { SessionMeta } from '../data/transcripts/meta.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT, isValidSessionId } from '../data/transcripts/projectKey.js';
import { LEGACY_TENANT_ID, TENANT_SLUG_PATTERN } from '../data/tenants/types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export interface RuntimeSessionProjectionRecord {
  sessionId: string;
  tenantId: string;
  userId?: string;
  username?: string;
  channel?: string;
  kind: 'user' | 'subagent';
  title?: string;
  runtimeStatus?: string;
  model?: string;
  executionTarget?: string;
  workspaceId?: string;
  createdAt?: string;
  updatedAt: string;
  deletedAt?: string;
  totalCostUsd?: number;
  metaJson: SessionMeta;
}

export interface RuntimeSessionMetaFile {
  sessionId: string;
  transcriptPath: string;
  metaPath: string;
  meta: SessionMeta;
  mtimeIso: string;
}

export interface RuntimeSessionBackfillPlan {
  root: string;
  scannedMetaFiles: number;
  validMetaFiles: number;
  skippedInvalidBasename: number;
  existingRows: number | null;
  wouldUpsert: number;
  wouldDeleteMissing: number | null;
  currentSessionIds: string[];
}

export interface RuntimeSessionBackfillResult extends RuntimeSessionBackfillPlan {
  upserted: number;
  deletedMissing: number;
}

export interface RuntimeSessionListQuery {
  tenantId?: string;
  userId?: string;
  titleContains?: string;
  status?: string;
  kind?: 'user' | 'subagent';
  model?: string;
  channel?: string;
  /** 按公司级专职 Agent 过滤（meta_json->>'orgAgentId'；2026-07 唯恩批次质检台） */
  orgAgentId?: string;
  /** true = 只要绑定了任意专职 Agent 的会话（orgAgentId 未指定时的"全部专职会话"视图） */
  hasOrgAgent?: boolean;
  /** updated_at 下界（ISO 8601，含；质检台时间过滤） */
  updatedFrom?: string;
  /** updated_at 上界（ISO 8601，含） */
  updatedTo?: string;
  includeDeleted?: boolean;
  cursor?: { updatedAt: string; sessionId: string };
  limit?: number;
}

export interface RuntimeSessionListResult {
  items: RuntimeSessionProjectionRecord[];
  nextCursor?: { updatedAt: string; sessionId: string };
}

export interface PgSessionProjectionStoreOptions {
  pool?: PgPool;
  connectionString?: string;
  tablePrefix?: string;
}

export class PgSessionProjectionStore {
  readonly pool: PgPool;
  readonly sessionsTable: string;
  private readonly ownsPool: boolean;

  constructor(options: PgSessionProjectionStoreOptions) {
    if (!options.pool && !options.connectionString) {
      throw new Error('PgSessionProjectionStore requires either pool or connectionString');
    }
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.sessionsTable = `${prefix}_sessions`;
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString! });
    this.ownsPool = !options.pool;
  }

  async init(): Promise<void> {
    const lockKey = `${this.sessionsTable}:init`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.sessionsTable} (
          session_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          user_id TEXT,
          username TEXT,
          channel TEXT,
          kind TEXT,
          title TEXT,
          runtime_status TEXT,
          model TEXT,
          execution_target TEXT,
          workspace_id TEXT,
          created_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL,
          deleted_at TIMESTAMPTZ,
          total_cost_usd NUMERIC,
          meta_json JSONB NOT NULL
        )
      `);
      await client.query(`ALTER TABLE ${this.sessionsTable} ADD COLUMN IF NOT EXISTS total_cost_usd NUMERIC`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.sessionsTable}_tenant_idx ON ${this.sessionsTable} (tenant_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.sessionsTable}_user_idx ON ${this.sessionsTable} (user_id, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.sessionsTable}_ws_idx ON ${this.sessionsTable} (workspace_id)`);
      // 质检台会话列表按 orgAgentId 过滤（2026-07 审查 F13）：partial 表达式索引，个人会话（无 orgAgentId）不占空间
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.sessionsTable}_org_agent_idx ON ${this.sessionsTable} ((meta_json->>'orgAgentId'), updated_at DESC) WHERE meta_json->>'orgAgentId' IS NOT NULL`);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  async upsertFromMeta(
    transcriptPath: string,
    meta: SessionMeta,
    options: { fallbackUpdatedAt?: string } = {},
  ): Promise<boolean> {
    const record = buildRuntimeSessionProjectionRecord(transcriptPath, meta, options);
    if (!record) return false;
    await this.pool.query(`
      INSERT INTO ${this.sessionsTable}
        (session_id, tenant_id, user_id, username, channel, kind, title, runtime_status,
         model, execution_target, workspace_id, created_at, updated_at, deleted_at,
         total_cost_usd, meta_json)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz,
         $14::timestamptz,$15,$16::jsonb)
      ON CONFLICT (session_id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        user_id = EXCLUDED.user_id,
        username = EXCLUDED.username,
        channel = EXCLUDED.channel,
        kind = EXCLUDED.kind,
        title = EXCLUDED.title,
        runtime_status = EXCLUDED.runtime_status,
        model = EXCLUDED.model,
        execution_target = EXCLUDED.execution_target,
        workspace_id = EXCLUDED.workspace_id,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        deleted_at = EXCLUDED.deleted_at,
        total_cost_usd = EXCLUDED.total_cost_usd,
        meta_json = EXCLUDED.meta_json
    `, [
      record.sessionId,
      record.tenantId,
      record.userId ?? null,
      record.username ?? null,
      record.channel ?? null,
      record.kind,
      record.title ?? null,
      record.runtimeStatus ?? null,
      record.model ?? null,
      record.executionTarget ?? null,
      record.workspaceId ?? null,
      record.createdAt ?? null,
      record.updatedAt,
      record.deletedAt ?? null,
      record.totalCostUsd ?? null,
      JSON.stringify(record.metaJson),
    ]);
    return true;
  }

  async deleteBySessionId(sessionId: string): Promise<number> {
    if (!isValidSessionId(sessionId)) return 0;
    const result = await this.pool.query(`DELETE FROM ${this.sessionsTable} WHERE session_id = $1`, [sessionId]);
    return result.rowCount ?? 0;
  }

  async deleteByTenant(tenantId: string): Promise<number> {
    const result = await this.pool.query(`DELETE FROM ${this.sessionsTable} WHERE tenant_id = $1`, [tenantId]);
    return result.rowCount ?? 0;
  }

  async get(
    sessionId: string,
    options: { tenantId?: string; includeDeleted?: boolean } = {},
  ): Promise<RuntimeSessionProjectionRecord | null> {
    const params: unknown[] = [sessionId];
    const clauses = ['session_id = $1'];
    if (options.tenantId) {
      params.push(options.tenantId);
      clauses.push(`tenant_id = $${params.length}`);
    }
    if (!options.includeDeleted) clauses.push('deleted_at IS NULL');
    const result = await this.pool.query<{ row_json: Record<string, unknown> }>(
      `SELECT row_to_json(${this.sessionsTable}.*) AS row_json
       FROM ${this.sessionsTable}
       WHERE ${clauses.join(' AND ')}
       LIMIT 1`,
      params,
    );
    return result.rows[0] ? rowToRuntimeSessionProjectionRecord(result.rows[0].row_json) : null;
  }

  async list(query: RuntimeSessionListQuery = {}): Promise<RuntimeSessionListResult> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (query.tenantId) {
      params.push(query.tenantId);
      clauses.push(`tenant_id = $${params.length}`);
    }
    if (query.userId) {
      params.push(query.userId);
      clauses.push(`user_id = $${params.length}`);
    }
    if (query.titleContains) {
      params.push(query.titleContains);
      clauses.push(`title IS NOT NULL AND position(lower($${params.length}) in lower(title)) > 0`);
    }
    if (query.status) {
      params.push(query.status);
      clauses.push(`runtime_status = $${params.length}`);
    }
    if (query.kind) {
      params.push(query.kind);
      clauses.push(`kind = $${params.length}`);
    }
    if (query.model) {
      params.push(query.model);
      clauses.push(`model = $${params.length}`);
    }
    if (query.channel) {
      params.push(query.channel);
      clauses.push(`channel = $${params.length}`);
    }
    if (query.orgAgentId) {
      params.push(query.orgAgentId);
      clauses.push(`meta_json->>'orgAgentId' = $${params.length}`);
    } else if (query.hasOrgAgent) {
      clauses.push(`meta_json->>'orgAgentId' IS NOT NULL`);
    }
    if (query.updatedFrom) {
      params.push(query.updatedFrom);
      clauses.push(`updated_at >= $${params.length}::timestamptz`);
    }
    if (query.updatedTo) {
      params.push(query.updatedTo);
      clauses.push(`updated_at <= $${params.length}::timestamptz`);
    }
    if (!query.includeDeleted) clauses.push('deleted_at IS NULL');
    if (query.cursor) {
      params.push(query.cursor.updatedAt, query.cursor.sessionId);
      const updatedAtParam = params.length - 1;
      const sessionIdParam = params.length;
      clauses.push(
        `(updated_at < $${updatedAtParam}::timestamptz OR (updated_at = $${updatedAtParam}::timestamptz AND session_id < $${sessionIdParam}))`,
      );
    }
    params.push(limit + 1);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query<{ row_json: Record<string, unknown> }>(
      `SELECT row_to_json(${this.sessionsTable}.*) AS row_json
       FROM ${this.sessionsTable}
       ${where}
       ORDER BY updated_at DESC, session_id DESC
       LIMIT $${params.length}`,
      params,
    );
    const rows = result.rows.map((row) => rowToRuntimeSessionProjectionRecord(row.row_json));
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      ...(hasMore && last ? { nextCursor: { updatedAt: last.updatedAt, sessionId: last.sessionId } } : {}),
    };
  }

  async planBackfill(root = AGENT_LEGACY_TRANSCRIPTS_ROOT): Promise<RuntimeSessionBackfillPlan> {
    const scan = await scanRuntimeSessionMetaFiles(root);
    const existing = await this.listProjectedSessionIds().catch(() => null);
    const currentSessionIds = scan.files.map((file) => file.sessionId);
    const currentSet = new Set(currentSessionIds);
    const wouldDeleteMissing = existing
      ? existing.filter((sessionId) => !currentSet.has(sessionId)).length
      : null;
    return {
      root,
      scannedMetaFiles: scan.scannedMetaFiles,
      validMetaFiles: scan.files.length,
      skippedInvalidBasename: scan.skippedInvalidBasename,
      existingRows: existing?.length ?? null,
      wouldUpsert: scan.files.length,
      wouldDeleteMissing,
      currentSessionIds,
    };
  }

  async reconcileFromFileSystem(root = AGENT_LEGACY_TRANSCRIPTS_ROOT): Promise<RuntimeSessionBackfillResult> {
    const plan = await this.planBackfill(root);
    let upserted = 0;
    for (const file of await scanRuntimeSessionMetaFiles(root).then((scan) => scan.files)) {
      if (await this.upsertFromMeta(file.transcriptPath, file.meta, { fallbackUpdatedAt: file.mtimeIso })) {
        upserted++;
      }
    }

    let deletedMissing = 0;
    if (plan.currentSessionIds.length > 0) {
      const result = await this.pool.query(
        `DELETE FROM ${this.sessionsTable} WHERE NOT (session_id = ANY($1::text[]))`,
        [plan.currentSessionIds],
      );
      deletedMissing = result.rowCount ?? 0;
    }

    return {
      ...plan,
      upserted,
      deletedMissing,
    };
  }

  private async listProjectedSessionIds(): Promise<string[]> {
    const result = await this.pool.query<{ session_id: string }>(
      `SELECT session_id FROM ${this.sessionsTable}`,
    );
    return result.rows.map((row) => row.session_id);
  }
}

export function buildRuntimeSessionProjectionRecord(
  transcriptPath: string,
  meta: SessionMeta,
  options: { fallbackUpdatedAt?: string } = {},
): RuntimeSessionProjectionRecord | null {
  const sessionId = sessionIdFromTranscriptPath(transcriptPath);
  if (!sessionId || !isValidSessionId(sessionId)) return null;
  const owner = ownerFromTranscriptPath(transcriptPath);
  const tenantId = normalizeTenantId(meta.tenantId) ?? owner?.tenantId ?? LEGACY_TENANT_ID;
  const userId = nonEmpty(meta.userId) ?? owner?.userId;
  const title = nonEmpty(meta.customTitle) ?? nonEmpty(meta.generatedTitle);
  const createdAt = normalizeIso(meta.createdAt);
  const deletedAt = normalizeIso(meta.deletedAt);
  const updatedAt = normalizeIso(meta.updatedAt)
    ?? deletedAt
    ?? createdAt
    ?? normalizeIso(options.fallbackUpdatedAt)
    ?? new Date().toISOString();

  return {
    sessionId,
    tenantId,
    ...(userId ? { userId } : {}),
    ...(nonEmpty(meta.username) ? { username: meta.username } : {}),
    ...(nonEmpty(meta.channel) ? { channel: meta.channel } : {}),
    kind: meta.kind === 'subagent' ? 'subagent' : 'user',
    ...(title ? { title } : {}),
    ...(nonEmpty(meta.runtimeStatus) ? { runtimeStatus: meta.runtimeStatus } : {}),
    ...(nonEmpty(meta.model) ? { model: meta.model } : {}),
    ...(nonEmpty(meta.executionTarget) ? { executionTarget: meta.executionTarget } : {}),
    ...(nonEmpty(meta.workspaceId) ? { workspaceId: meta.workspaceId } : {}),
    ...(createdAt ? { createdAt } : {}),
    updatedAt,
    ...(deletedAt ? { deletedAt } : {}),
    ...(typeof meta.totalCostUsd === 'number' && Number.isFinite(meta.totalCostUsd)
      ? { totalCostUsd: meta.totalCostUsd }
      : {}),
    metaJson: meta,
  };
}

export async function scanRuntimeSessionMetaFiles(root = AGENT_LEGACY_TRANSCRIPTS_ROOT): Promise<{
  scannedMetaFiles: number;
  skippedInvalidBasename: number;
  files: RuntimeSessionMetaFile[];
}> {
  const files: RuntimeSessionMetaFile[] = [];
  let scannedMetaFiles = 0;
  let skippedInvalidBasename = 0;

  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.meta.json')) continue;
      scannedMetaFiles++;
      const sessionId = entry.name.slice(0, -'.meta.json'.length);
      if (!isValidSessionId(sessionId)) {
        skippedInvalidBasename++;
        continue;
      }
      try {
        const raw = await readFile(fullPath, 'utf-8');
        const meta = JSON.parse(raw) as SessionMeta;
        const fileStat = await stat(fullPath);
        files.push({
          sessionId,
          metaPath: fullPath,
          transcriptPath: fullPath.replace(/\.meta\.json$/, '.jsonl'),
          meta,
          mtimeIso: new Date(fileStat.mtimeMs).toISOString(),
        });
      } catch {
        skippedInvalidBasename++;
      }
    }
  }

  await walk(root);
  return { scannedMetaFiles, skippedInvalidBasename, files };
}

export function runtimeSessionsDdl(tablePrefix = 'runtime'): string[] {
  const table = `${sanitizeIdentifier(tablePrefix)}_sessions`;
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (session_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, username TEXT, channel TEXT, kind TEXT, title TEXT, runtime_status TEXT, model TEXT, execution_target TEXT, workspace_id TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ, total_cost_usd NUMERIC, meta_json JSONB NOT NULL);`,
    `CREATE INDEX IF NOT EXISTS ${table}_tenant_idx ON ${table} (tenant_id, updated_at DESC);`,
    `CREATE INDEX IF NOT EXISTS ${table}_user_idx ON ${table} (user_id, updated_at DESC);`,
    `CREATE INDEX IF NOT EXISTS ${table}_ws_idx ON ${table} (workspace_id);`,
  ];
}

function sessionIdFromTranscriptPath(transcriptPath: string): string | null {
  const name = basename(transcriptPath);
  if (name.endsWith('.meta.json')) return name.slice(0, -'.meta.json'.length);
  if (name.endsWith('.jsonl')) return name.slice(0, -'.jsonl'.length);
  return null;
}

function ownerFromTranscriptPath(transcriptPath: string): { tenantId: string; userId: string } | null {
  const rel = relative(resolve(AGENT_LEGACY_TRANSCRIPTS_ROOT), resolve(transcriptPath));
  if (rel.startsWith('..')) return null;
  const parts = rel.split(/[\\/]/);
  if (parts.length < 3) return null;
  const [tenantId, userId] = parts;
  if (!tenantId || !userId || tenantId === '__anonymous') return null;
  if (!TENANT_SLUG_PATTERN.test(tenantId)) return null;
  return { tenantId, userId };
}

function normalizeTenantId(value: string | undefined): string | undefined {
  return value && TENANT_SLUG_PATTERN.test(value) ? value : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function rowToRuntimeSessionProjectionRecord(raw: any): RuntimeSessionProjectionRecord {
  const metaJson = typeof raw.meta_json === 'string'
    ? JSON.parse(raw.meta_json) as SessionMeta
    : raw.meta_json as SessionMeta;
  return {
    sessionId: raw.session_id ?? raw.sessionId,
    tenantId: raw.tenant_id ?? raw.tenantId,
    userId: raw.user_id ?? raw.userId ?? undefined,
    username: raw.username ?? undefined,
    channel: raw.channel ?? undefined,
    kind: raw.kind === 'subagent' ? 'subagent' : 'user',
    title: raw.title ?? undefined,
    runtimeStatus: raw.runtime_status ?? raw.runtimeStatus ?? undefined,
    model: raw.model ?? undefined,
    executionTarget: raw.execution_target ?? raw.executionTarget ?? undefined,
    workspaceId: raw.workspace_id ?? raw.workspaceId ?? undefined,
    createdAt: raw.created_at ? new Date(raw.created_at).toISOString() : raw.createdAt,
    updatedAt: new Date(raw.updated_at ?? raw.updatedAt).toISOString(),
    deletedAt: raw.deleted_at ? new Date(raw.deleted_at).toISOString() : raw.deletedAt,
    totalCostUsd: raw.total_cost_usd !== null && raw.total_cost_usd !== undefined
      ? Number(raw.total_cost_usd)
      : raw.totalCostUsd,
    metaJson,
  };
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}
