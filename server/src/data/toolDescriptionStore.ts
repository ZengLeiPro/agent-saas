import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ToolControlsConfig, ToolDescriptionOverride } from '../app/config.js';

export interface ToolDescriptionSnapshot {
  revision: string;
  /** null is a durable tombstone: clear also masks legacy config.json overrides. */
  overrides: Record<string, ToolDescriptionOverride | null>;
}

export class ToolDescriptionConflictError extends Error {
  readonly code = 'TOOL_DESCRIPTION_CONFLICT';
  constructor() {
    super('工具提示语已被其他管理员更新，请刷新后重试');
  }
}

export interface ToolDescriptionStore {
  get(): Promise<ToolDescriptionSnapshot>;
  update(
    toolId: string,
    override: ToolDescriptionOverride | null,
    expectedRevision: string,
    actor: string,
  ): Promise<ToolDescriptionSnapshot>;
}

export function mergeToolDescriptionOverrides(
  baseline: ToolControlsConfig,
  overrides: ToolDescriptionSnapshot['overrides'],
): ToolControlsConfig {
  const next = structuredClone(baseline ?? {});
  for (const [toolId, override] of Object.entries(overrides)) {
    const tools = (next.tools ??= {});
    const entry = (tools[toolId] ??= {});
    if (override === null) delete entry.descriptionOverride;
    else entry.descriptionOverride = structuredClone(override);
  }
  return next;
}

/** Runtime data, deliberately outside the release-bound AppConfig identity. */
// release-migration: expand
export class PgToolDescriptionStore implements ToolDescriptionStore {
  private readonly table: string;
  private readonly auditTable: string;

  constructor(
    private readonly pool: pg.Pool,
    prefix = 'runtime',
  ) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(prefix)) throw new Error('Invalid PG table prefix');
    this.table = `${prefix}_tool_descriptions`;
    this.auditTable = `${prefix}_tool_description_audit`;
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.table]);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        revision TEXT NOT NULL,
        overrides JSONB NOT NULL DEFAULT '{}'
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.auditTable} (
        revision TEXT PRIMARY KEY, tool_id TEXT NOT NULL,
        previous_override JSONB, next_override JSONB,
        actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(
        `INSERT INTO ${this.table} (id, revision) VALUES (1, $1) ON CONFLICT DO NOTHING`,
        [randomUUID()],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async get(): Promise<ToolDescriptionSnapshot> {
    const result = await this.pool.query<ToolDescriptionSnapshot>(
      `SELECT revision, overrides FROM ${this.table} WHERE id = 1`,
    );
    if (!result.rows[0]) throw new Error('工具提示语存储尚未初始化');
    return result.rows[0];
  }

  async update(
    toolId: string,
    override: ToolDescriptionOverride | null,
    expectedRevision: string,
    actor: string,
  ): Promise<ToolDescriptionSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = (
        await client.query<ToolDescriptionSnapshot>(
          `SELECT revision, overrides FROM ${this.table} WHERE id = 1 FOR UPDATE`,
        )
      ).rows[0];
      if (!current || current.revision !== expectedRevision)
        throw new ToolDescriptionConflictError();
      const next = {
        revision: randomUUID(),
        overrides: { ...current.overrides, [toolId]: override },
      };
      await client.query(
        `UPDATE ${this.table} SET revision = $1, overrides = $2::jsonb WHERE id = 1`,
        [next.revision, JSON.stringify(next.overrides)],
      );
      await client.query(
        `INSERT INTO ${this.auditTable} (revision, tool_id, previous_override, next_override, actor)
        VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
        [
          next.revision,
          toolId,
          JSON.stringify(current.overrides[toolId] ?? null),
          JSON.stringify(override),
          actor,
        ],
      );
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function initializeToolDescriptionStore(
  pool: pg.Pool | undefined,
  prefix?: string,
): Promise<ToolDescriptionStore | undefined> {
  if (!pool) return undefined;
  const store = new PgToolDescriptionStore(pool, prefix);
  await store.init();
  return store;
}
