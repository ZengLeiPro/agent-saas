import type pg from 'pg';

type PgPool = pg.Pool;

const DEFAULT_MAX_CONFIGURABLE_CONCURRENT_RUNS = 64;

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid PG table prefix: ${value}`);
  }
  return value;
}

function normalizePositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} 必须是正整数`);
  }
  return value;
}

export type RuntimeSessionLockMode = 'dual' | 'lease';

export interface RuntimeSchedulerConfigRecord {
  maxConcurrentRuns: number;
  updatedAt: string;
  updatedBy?: string;
}

export interface RuntimeSchedulerCapacitySnapshot extends RuntimeSchedulerConfigRecord {
  status: 'ok';
  sessionLockMode: RuntimeSessionLockMode;
  effectiveMaxConcurrentRuns: number;
  maxConfigurableConcurrentRuns: number;
  editable: boolean;
  inFlightRuns: number;
  inFlightBackgroundRuns: number;
}

export interface RuntimeSchedulerCapacityController {
  getSnapshot(): Promise<RuntimeSchedulerCapacitySnapshot>;
  updateMaxConcurrentRuns(value: number, actor: string): Promise<RuntimeSchedulerCapacitySnapshot>;
}

export function effectiveMaxConcurrentRuns(
  desired: number,
  sessionLockMode: RuntimeSessionLockMode,
): number {
  return sessionLockMode === 'dual' ? Math.min(desired, 4) : desired;
}

export class PgRuntimeSchedulerConfigStore {
  readonly table: string;
  readonly maxConfigurableConcurrentRuns: number;

  constructor(
    private readonly pool: PgPool,
    options: {
      tablePrefix?: string;
      maxConfigurableConcurrentRuns?: number;
    } = {},
  ) {
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.table = `${prefix}_scheduler_config`;
    this.maxConfigurableConcurrentRuns = normalizePositiveInt(
      options.maxConfigurableConcurrentRuns ?? DEFAULT_MAX_CONFIGURABLE_CONCURRENT_RUNS,
      'runtimeScheduler.maxConfigurableConcurrentRuns',
    );
  }

  async init(defaultMaxConcurrentRuns: number): Promise<void> {
    const initialValue = normalizePositiveInt(defaultMaxConcurrentRuns, 'runtimeScheduler.maxConcurrentRuns');
    if (initialValue > this.maxConfigurableConcurrentRuns) {
      throw new Error(
        `runtimeScheduler.maxConcurrentRuns ${initialValue} 超过部署安全上限 ${this.maxConfigurableConcurrentRuns}`,
      );
    }
    const lockKey = `${this.table}:init`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          id SMALLINT PRIMARY KEY CHECK (id = 1),
          max_concurrent_runs INTEGER NOT NULL CHECK (max_concurrent_runs > 0),
          updated_at TIMESTAMPTZ NOT NULL,
          updated_by TEXT
        )
      `);
      await client.query(
        `INSERT INTO ${this.table} (id, max_concurrent_runs, updated_at, updated_by)
         VALUES (1, $1, NOW(), 'bootstrap')
         ON CONFLICT (id) DO NOTHING`,
        [initialValue],
      );
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async get(): Promise<RuntimeSchedulerConfigRecord> {
    const result = await this.pool.query<{
      max_concurrent_runs: number;
      updated_at: Date | string;
      updated_by: string | null;
    }>(
      `SELECT max_concurrent_runs, updated_at, updated_by
       FROM ${this.table}
       WHERE id = 1`,
    );
    const row = result.rows[0];
    if (!row) throw new Error('Runtime scheduler config is not initialized');
    const maxConcurrentRuns = normalizePositiveInt(
      Number(row.max_concurrent_runs),
      'maxConcurrentRuns',
    );
    if (maxConcurrentRuns > this.maxConfigurableConcurrentRuns) {
      throw new Error(
        `PG 中的 maxConcurrentRuns ${maxConcurrentRuns} 超过部署安全上限 ${this.maxConfigurableConcurrentRuns}`,
      );
    }
    return {
      maxConcurrentRuns,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
    };
  }

  async update(maxConcurrentRuns: number, actor: string): Promise<RuntimeSchedulerConfigRecord> {
    const next = normalizePositiveInt(maxConcurrentRuns, 'maxConcurrentRuns');
    if (next > this.maxConfigurableConcurrentRuns) {
      throw new Error(`maxConcurrentRuns 不能超过部署安全上限 ${this.maxConfigurableConcurrentRuns}`);
    }
    const result = await this.pool.query<{
      max_concurrent_runs: number;
      updated_at: Date | string;
      updated_by: string | null;
    }>(
      `UPDATE ${this.table}
       SET max_concurrent_runs = $1,
           updated_at = NOW(),
           updated_by = $2
       WHERE id = 1
       RETURNING max_concurrent_runs, updated_at, updated_by`,
      [next, actor],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Runtime scheduler config is not initialized');
    return {
      maxConcurrentRuns: Number(row.max_concurrent_runs),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
    };
  }
}
