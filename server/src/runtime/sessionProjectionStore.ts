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

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}
