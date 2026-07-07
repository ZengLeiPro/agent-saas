import pg from 'pg';

const { Pool } = pg;

type PgPool = InstanceType<typeof Pool>;

export type SystemMetricName =
  | 'disk_root'
  | 'disk_nas'
  | 'pg_table_size'
  | 'server_data_size'
  | 'sqlite_size'
  | 'tls_cert_expiry'
  | 'workspace_scan';

export type WorkspaceUsageStatus = 'active' | 'soft_deleted' | 'orphan_tenant' | 'orphan_user';

export interface SystemMetricRecord {
  id: number;
  metric: SystemMetricName | string;
  label: string;
  valueNum: number;
  detailJson: Record<string, unknown> | null;
  sampledAt: string;
}

export interface WorkspaceUsageRecord {
  path: string;
  tenantId: string;
  userId: string | null;
  status: WorkspaceUsageStatus;
  bytes: number;
  fileCount: number | null;
  scannedAt: string;
  archivedAt: string | null;
}

export interface UpsertWorkspaceUsageInput {
  path: string;
  tenantId: string;
  userId?: string | null;
  status: WorkspaceUsageStatus;
  bytes: number;
  fileCount?: number | null;
  scannedAt: Date;
}

export interface SystemStorageSummary {
  totalBytes: number;
  orphanBytes: number;
  orphanCount: number;
  byTenant: Array<{ tenantId: string; bytes: number; workspaceCount: number }>;
  lastScanAt: string | null;
}

export interface PgSystemMetricsStoreOptions {
  pool?: PgPool;
  connectionString?: string;
  tablePrefix?: string;
}

export class PgSystemMetricsStore {
  readonly pool: PgPool;
  readonly systemMetricsTable: string;
  readonly workspaceUsageTable: string;
  private readonly ownsPool: boolean;

  constructor(options: PgSystemMetricsStoreOptions) {
    if (!options.pool && !options.connectionString) {
      throw new Error('PgSystemMetricsStore requires either pool or connectionString');
    }
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.systemMetricsTable = `${prefix}_system_metrics`;
    this.workspaceUsageTable = `${prefix}_workspace_usage`;
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString! });
    this.ownsPool = !options.pool;
  }

  async init(): Promise<void> {
    const lockKey = `${this.systemMetricsTable}:init`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.systemMetricsTable} (
          id BIGSERIAL PRIMARY KEY,
          metric TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT '',
          value_num NUMERIC NOT NULL,
          detail_json JSONB,
          sampled_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.systemMetricsTable}_metric_ts_idx
        ON ${this.systemMetricsTable} (metric, label, sampled_at DESC)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.workspaceUsageTable} (
          path TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          user_id TEXT,
          status TEXT NOT NULL,
          bytes BIGINT NOT NULL,
          file_count INTEGER,
          scanned_at TIMESTAMPTZ NOT NULL,
          archived_at TIMESTAMPTZ
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.workspaceUsageTable}_tenant_idx
        ON ${this.workspaceUsageTable} (tenant_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.workspaceUsageTable}_status_idx
        ON ${this.workspaceUsageTable} (status)
      `);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async insertMetric(input: {
    metric: SystemMetricName | string;
    label?: string;
    valueNum: number;
    detailJson?: Record<string, unknown> | null;
    sampledAt?: Date;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.systemMetricsTable} (metric, label, value_num, detail_json, sampled_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        input.metric,
        input.label ?? '',
        input.valueNum,
        input.detailJson ? JSON.stringify(input.detailJson) : null,
        input.sampledAt ?? new Date(),
      ],
    );
  }

  async pruneSystemMetrics(retentionDays: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM ${this.systemMetricsTable}
       WHERE sampled_at < now() - ($1::int * interval '1 day')`,
      [retentionDays],
    );
    return result.rowCount ?? 0;
  }

  async listLatestMetrics(): Promise<SystemMetricRecord[]> {
    const result = await this.pool.query<MetricRow>(
      `SELECT DISTINCT ON (metric, label)
         id, metric, label, value_num::float8 AS value_num, detail_json, sampled_at
       FROM ${this.systemMetricsTable}
       ORDER BY metric, label, sampled_at DESC`,
    );
    return result.rows.map(mapMetricRow);
  }

  async listMetricsSince(hours: number): Promise<SystemMetricRecord[]> {
    const result = await this.pool.query<MetricRow>(
      `SELECT id, metric, label, value_num::float8 AS value_num, detail_json, sampled_at
       FROM ${this.systemMetricsTable}
       WHERE sampled_at >= now() - ($1::int * interval '1 hour')
       ORDER BY sampled_at DESC, metric, label`,
      [hours],
    );
    return result.rows.map(mapMetricRow);
  }

  async getLatestMetric(metric: SystemMetricName | string, label = ''): Promise<SystemMetricRecord | null> {
    const result = await this.pool.query<MetricRow>(
      `SELECT id, metric, label, value_num::float8 AS value_num, detail_json, sampled_at
       FROM ${this.systemMetricsTable}
       WHERE metric = $1 AND label = $2
       ORDER BY sampled_at DESC
       LIMIT 1`,
      [metric, label],
    );
    return result.rows[0] ? mapMetricRow(result.rows[0]) : null;
  }

  async listPgTopTables(limit = 5): Promise<Array<{ table: string; bytes: number; sampledAt: string }>> {
    const result = await this.pool.query<{ label: string; value_num: number; sampled_at: Date | string }>(
      `SELECT DISTINCT ON (label) label, value_num::float8 AS value_num, sampled_at
       FROM ${this.systemMetricsTable}
       WHERE metric = 'pg_table_size'
       ORDER BY label, sampled_at DESC`,
    );
    return result.rows
      .map((row) => ({ table: row.label, bytes: Number(row.value_num), sampledAt: toIso(row.sampled_at) }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, limit);
  }

  async upsertWorkspaceUsage(
    records: UpsertWorkspaceUsageInput[],
    scannedAt: Date,
    detailPatch: Record<string, unknown> = {},
    options: { partial?: boolean } = {},
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const record of records) {
        await client.query(
          `INSERT INTO ${this.workspaceUsageTable}
             (path, tenant_id, user_id, status, bytes, file_count, scanned_at, archived_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
           ON CONFLICT (path) DO UPDATE SET
             tenant_id = EXCLUDED.tenant_id,
             user_id = EXCLUDED.user_id,
             status = EXCLUDED.status,
             bytes = EXCLUDED.bytes,
             file_count = EXCLUDED.file_count,
             scanned_at = EXCLUDED.scanned_at,
             archived_at = NULL`,
          [
            record.path,
            record.tenantId,
            record.userId ?? null,
            record.status,
            normalizeBytes(record.bytes),
            record.fileCount ?? null,
            record.scannedAt,
          ],
        );
      }
      // FIX-1: partial 轮（有租户目录读取失败）只 upsert，不删除「本轮未见 path」，
      // 防止把只是暂时读不到的目录当作已消失清掉。
      if (!options.partial) {
        const paths = records.map((record) => record.path);
        await client.query(
          paths.length > 0
            ? `DELETE FROM ${this.workspaceUsageTable} WHERE NOT (path = ANY($1::text[]))`
            : `DELETE FROM ${this.workspaceUsageTable}`,
          paths.length > 0 ? [paths] : [],
        );
      }
      await client.query(
        `INSERT INTO ${this.systemMetricsTable} (metric, label, value_num, detail_json, sampled_at)
         VALUES ('workspace_scan', '', $1, $2::jsonb, $3)`,
        [
          records.reduce((sum, record) => sum + Math.max(0, normalizeBytes(record.bytes)), 0),
          JSON.stringify({
            dirs: records.length,
            orphans: records.filter((record) => record.status !== 'active').length,
            ...detailPatch,
          }),
          scannedAt,
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async countWorkspaceUsage(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${this.workspaceUsageTable}`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listWorkspaceUsage(): Promise<WorkspaceUsageRecord[]> {
    const result = await this.pool.query<WorkspaceUsageRow>(
      `SELECT path, tenant_id, user_id, status, bytes::text AS bytes, file_count, scanned_at, archived_at
       FROM ${this.workspaceUsageTable}
       ORDER BY bytes DESC, path ASC`,
    );
    return result.rows.map(mapWorkspaceUsageRow);
  }

  async getWorkspaceUsage(path: string): Promise<WorkspaceUsageRecord | null> {
    const result = await this.pool.query<WorkspaceUsageRow>(
      `SELECT path, tenant_id, user_id, status, bytes::text AS bytes, file_count, scanned_at, archived_at
       FROM ${this.workspaceUsageTable}
       WHERE path = $1
       LIMIT 1`,
      [path],
    );
    return result.rows[0] ? mapWorkspaceUsageRow(result.rows[0]) : null;
  }

  async deleteWorkspaceUsage(path: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.workspaceUsageTable} WHERE path = $1`, [path]);
  }

  async getWorkspaceStorageSummary(): Promise<SystemStorageSummary> {
    const [summary, byTenant, scan] = await Promise.all([
      // FIX-4: bytes = -1 表示 du 失败/超时，求和时排除，避免污染汇总。
      this.pool.query<{ total_bytes: string; orphan_bytes: string; orphan_count: string }>(
        `SELECT
           COALESCE(sum(bytes) FILTER (WHERE bytes >= 0),0)::text AS total_bytes,
           COALESCE(sum(bytes) FILTER (WHERE status <> 'active' AND bytes >= 0),0)::text AS orphan_bytes,
           count(*) FILTER (WHERE status <> 'active')::text AS orphan_count
         FROM ${this.workspaceUsageTable}`,
      ),
      this.pool.query<{ tenant_id: string; bytes: string; workspace_count: string }>(
        `SELECT tenant_id, COALESCE(sum(bytes) FILTER (WHERE bytes >= 0),0)::text AS bytes, count(*)::text AS workspace_count
         FROM ${this.workspaceUsageTable}
         GROUP BY tenant_id
         ORDER BY COALESCE(sum(bytes) FILTER (WHERE bytes >= 0),0) DESC`,
      ),
      this.getLatestMetric('workspace_scan'),
    ]);
    const row = summary.rows[0];
    return {
      totalBytes: Number(row?.total_bytes ?? 0),
      orphanBytes: Number(row?.orphan_bytes ?? 0),
      orphanCount: Number(row?.orphan_count ?? 0),
      byTenant: byTenant.rows.map((item) => ({
        tenantId: item.tenant_id,
        bytes: Number(item.bytes),
        workspaceCount: Number(item.workspace_count),
      })),
      lastScanAt: scan?.sampledAt ?? null,
    };
  }

  async queryPgRuntimeTableSizes(prefix = 'runtime'): Promise<Array<{ table: string; bytes: number }>> {
    const result = await this.pool.query<{ table_name: string; bytes: string }>(
      `SELECT tablename AS table_name, pg_total_relation_size((quote_ident(schemaname) || '.' || quote_ident(tablename))::regclass)::text AS bytes
       FROM pg_tables
       WHERE schemaname = current_schema()
         AND tablename LIKE $1
       ORDER BY pg_total_relation_size((quote_ident(schemaname) || '.' || quote_ident(tablename))::regclass) DESC`,
      [`${prefix}_%`],
    );
    return result.rows.map((row) => ({ table: row.table_name, bytes: Number(row.bytes) }));
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

interface MetricRow {
  id: number;
  metric: string;
  label: string;
  value_num: number;
  detail_json: Record<string, unknown> | null;
  sampled_at: Date | string;
}

interface WorkspaceUsageRow {
  path: string;
  tenant_id: string;
  user_id: string | null;
  status: WorkspaceUsageStatus;
  bytes: string;
  file_count: number | null;
  scanned_at: Date | string;
  archived_at: Date | string | null;
}

function mapMetricRow(row: MetricRow): SystemMetricRecord {
  return {
    id: Number(row.id),
    metric: row.metric,
    label: row.label,
    valueNum: Number(row.value_num),
    detailJson: row.detail_json,
    sampledAt: toIso(row.sampled_at),
  };
}

function mapWorkspaceUsageRow(row: WorkspaceUsageRow): WorkspaceUsageRecord {
  return {
    path: row.path,
    tenantId: row.tenant_id,
    userId: row.user_id,
    status: row.status,
    bytes: Number(row.bytes),
    fileCount: row.file_count,
    scannedAt: toIso(row.scanned_at),
    archivedAt: row.archived_at ? toIso(row.archived_at) : null,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// FIX-4: -1 表示 du 失败/超时（与空目录的 0 区分），允许落库；其余负值一律归一为 -1。
function normalizeBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) return -1;
  return Math.trunc(bytes);
}

function sanitizeIdentifier(input: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input)) {
    throw new Error(`Invalid SQL identifier prefix: ${input}`);
  }
  return input;
}
