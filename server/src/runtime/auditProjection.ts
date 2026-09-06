/**
 * Runtime audit DB projection (DuckDB)
 *
 * 把 `*.runtime-events.jsonl` 里的 `tool_audit` 事件投影到 DuckDB 单文件
 * (`<dataDir>/audit.duckdb`)，为跨 session runId 查询、按 tool_name + 时间窗
 * 聚合分析等 admin 用例提供 SQL 入口。
 *
 * 设计取舍（§22.7 第三步）：
 * - DuckDB 选型：列存 + 单文件 + 无需服务进程；本地 PoC 起步够用，未来 SaaS
 *   可平迁到 MotherDuck / Parquet on S3。
 * - 物理隔离 `business.sqlite`：audit 读写不与业务事务共享句柄/锁，互不影响。
 * - 事实源仍是磁盘 jsonl，DuckDB 是 read replica：每次启动全量投影一次，
 *   增量靠 `watermark(file_path → byte_offset)`；EventStore 模式仍可用作 fallback。
 * - 仅投影 `tool_audit`；其它 `PlatformEvent` 类型暂不入库，避免 schema 蔓延。
 *
 * Public API：
 *   - `createAuditProjection({ db, root?, logger? })` → `AuditProjection`
 *   - `AuditProjection.initialize()`：创建 schema + index（idempotent）
 *   - `AuditProjection.tick()`：扫 root 下所有 `*.runtime-events.jsonl` 做增量投影
 *   - `AuditProjection.tickFile(filePath)`：单文件增量
 *   - `AuditProjection.clear()`：测试 / 强制全量重投用，慎用
 */
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { DuckDBConnection } from '@duckdb/node-api';

import { ALLOWED_ROOT } from '../data/transcripts/projectKey.js';
import { LEGACY_TENANT_ID } from '../data/tenants/types.js';
import type { PlatformEvent } from './types.js';

type ToolAuditEvent = Extract<PlatformEvent, { type: 'tool_audit' }>;

/** runtime-events 文件后缀，与 `getRuntimeEventLogPath` 保持一致 */
export const RUNTIME_EVENTS_SUFFIX = '.runtime-events.jsonl';

export interface AuditProjectionLogger {
  info?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  error?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface CreateAuditProjectionOptions {
  /** 已 `connect()` 的 DuckDB connection；归 caller 负责 close */
  db: DuckDBConnection;
  /** 扫描根目录；默认 Agent SaaS transcript root */
  root?: string;
  /** 可选 logger，缺省 silent */
  logger?: AuditProjectionLogger;
}

export interface TickFileResult {
  bytesRead: number;
  eventsInserted: number;
  /** 该文件因 size < watermark 触发 reset 与全量重投 */
  reset: boolean;
}

export interface TickStats {
  filesScanned: number;
  /** 实际有 bytes 增量被处理的文件数 */
  filesProjected: number;
  eventsInserted: number;
  /** 文件回退导致 reset 的次数 */
  resets: number;
  /** 单文件投影抛错次数（不抛出，记录在 stats 内）*/
  errors: number;
}

function createToolAuditTableSql(tableName: string, ifNotExists = false): string {
  return `
CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (
  id            VARCHAR   NOT NULL,
  timestamp     TIMESTAMP NOT NULL,
  session_id    VARCHAR   NOT NULL,
  run_id        VARCHAR   NOT NULL,
  tenant_id     VARCHAR   NOT NULL DEFAULT '${LEGACY_TENANT_ID}',
  source_file_path VARCHAR NOT NULL,
  tool_call_id  VARCHAR   NOT NULL,
  tool_id       VARCHAR   NOT NULL,
  tool_name     VARCHAR   NOT NULL,
  skill_name    VARCHAR,
  risk          VARCHAR   NOT NULL,
  approval_id   VARCHAR,
  authorization_source       VARCHAR NOT NULL,
  authorization_json         VARCHAR NOT NULL,
  execution_target           VARCHAR NOT NULL,
  status                     VARCHAR NOT NULL,
  duration_ms                BIGINT  NOT NULL,
  execution_invocations_json VARCHAR,
  error                      VARCHAR,
  -- WP3 §6.2-8：定制项目能力调用的审计扩展。只有 app__ 工具会写，其余行全为 NULL。
  -- input_hash / output_hash 只存 sha256，绝不存明文入参与结果。
  app_user_id       VARCHAR,
  app_installation_id VARCHAR,
  app_capability_id VARCHAR,
  app_lcid          VARCHAR,
  app_request_id    VARCHAR,
  app_dig           VARCHAR,
  app_input_hash    VARCHAR,
  app_output_hash   VARCHAR,
  app_output_bytes  BIGINT,
  app_error_code    VARCHAR,
  app_origin        VARCHAR,
  PRIMARY KEY (tenant_id, id)
);
`;
}

const SCHEMA_TOOL_AUDIT = createToolAuditTableSql('tool_audit', true);
const TOOL_AUDIT_MIGRATION_TABLE = 'tool_audit__tenant_pk_migration';

/** 旧 DuckDB 文件升级路径。任何 DDL/拷贝失败都必须阻断初始化，不能带旧主键继续服务。 */
const ALTER_TOOL_AUDIT_TENANT = `
ALTER TABLE tool_audit ADD COLUMN tenant_id VARCHAR DEFAULT '${LEGACY_TENANT_ID}';
`;

const ALTER_TOOL_AUDIT_SKILL = `
ALTER TABLE tool_audit ADD COLUMN skill_name VARCHAR;
`;

/**
 * WP3 §6.2-8 的 11 列。旧 DuckDB 文件逐列补齐；DuckDB 的 ADD COLUMN 无 IF NOT EXISTS，
 * 因此调用方要先 `tableHasColumn` 判定（与 tenant_id / skill_name 同一套路）。
 */
const ALTER_TOOL_AUDIT_APP_COLUMNS: ReadonlyArray<{ column: string; sql: string }> = [
  ['app_user_id', 'VARCHAR'],
  ['app_installation_id', 'VARCHAR'],
  ['app_capability_id', 'VARCHAR'],
  ['app_lcid', 'VARCHAR'],
  ['app_request_id', 'VARCHAR'],
  ['app_dig', 'VARCHAR'],
  ['app_input_hash', 'VARCHAR'],
  ['app_output_hash', 'VARCHAR'],
  ['app_output_bytes', 'BIGINT'],
  ['app_error_code', 'VARCHAR'],
  ['app_origin', 'VARCHAR'],
].map(([column, type]) => ({
  column: column!,
  sql: `ALTER TABLE tool_audit ADD COLUMN ${column} ${type};`,
}));

const SCHEMA_WATERMARK = `
CREATE TABLE IF NOT EXISTS projection_watermark (
  file_path       VARCHAR PRIMARY KEY,
  byte_offset     BIGINT  NOT NULL,
  updated_at      TIMESTAMP NOT NULL,
  tenant_ids_json VARCHAR NOT NULL DEFAULT '[]'
);
`;

const ALTER_WATERMARK_TENANTS = `
ALTER TABLE projection_watermark ADD COLUMN tenant_ids_json VARCHAR DEFAULT '[]';
`;

const TOOL_AUDIT_COLUMNS = `
  id, timestamp, session_id, run_id, tenant_id, source_file_path,
  tool_call_id, tool_id, tool_name, skill_name, risk, approval_id,
  authorization_source, authorization_json, execution_target, status,
  duration_ms, execution_invocations_json, error,
  app_user_id, app_installation_id, app_capability_id, app_lcid, app_request_id,
  app_dig, app_input_hash, app_output_hash, app_output_bytes, app_error_code, app_origin
`;

const SCHEMA_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_session     ON tool_audit(session_id);`,
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_run         ON tool_audit(run_id);`,
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_ts          ON tool_audit(timestamp);`,
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_tool        ON tool_audit(tool_name, timestamp);`,
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_skill       ON tool_audit(skill_name, timestamp);`,
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_source      ON tool_audit(source_file_path);`,
  // PR 10：(tenant, *) 复合索引为 admin 跨 session / 跨 runId 加 tenantId where 提速
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_tenant_run  ON tool_audit(tenant_id, run_id);`,
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_tenant_sess ON tool_audit(tenant_id, session_id);`,
  // WP3：按安装实例做能力用量与故障排查（app_installation_id 为 NULL 的行不进索引热区）
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_app_install  ON tool_audit(app_installation_id, timestamp);`,
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_app_lcid     ON tool_audit(app_lcid);`,
];

export class AuditProjection {
  constructor(
    private readonly db: DuckDBConnection,
    private readonly root: string,
    private readonly logger: AuditProjectionLogger,
  ) {}

  /** 创建 schema + 索引；调用多次安全。旧的 id-only 主键以事务方式 fail-closed 迁移。 */
  async initialize(): Promise<void> {
    const toolAuditHadTenant = await this.tableHasColumn('tool_audit', 'tenant_id');
    const toolAuditHadSkill = await this.tableHasColumn('tool_audit', 'skill_name');
    const watermarkHadTenantBoundary = await this.tableHasColumn('projection_watermark', 'tenant_ids_json');
    await this.db.run(SCHEMA_TOOL_AUDIT);
    await this.db.run(SCHEMA_WATERMARK);
    if (!toolAuditHadTenant && !await this.tableHasColumn('tool_audit', 'tenant_id')) {
      // DuckDB 不支持 ADD COLUMN ... NOT NULL；事务重建会在新表恢复 NOT NULL。
      await this.db.run(ALTER_TOOL_AUDIT_TENANT);
    }
    if (!toolAuditHadSkill && !await this.tableHasColumn('tool_audit', 'skill_name')) {
      await this.db.run(ALTER_TOOL_AUDIT_SKILL);
    }
    for (const { column, sql } of ALTER_TOOL_AUDIT_APP_COLUMNS) {
      if (!await this.tableHasColumn('tool_audit', column)) await this.db.run(sql);
    }
    if (!watermarkHadTenantBoundary) {
      if (!await this.tableHasColumn('projection_watermark', 'tenant_ids_json')) {
        await this.db.run(ALTER_WATERMARK_TENANTS);
      }
      // 旧 watermark 无租户来源信息，不能安全用于 reset；由事实源全量重建。
      await this.db.run('DELETE FROM projection_watermark;');
    }

    await this.ensureSourceFileProvenance();
    await this.ensureTenantScopedPrimaryKey();
    for (const ddl of SCHEMA_INDEXES) {
      await this.db.run(ddl);
    }
  }

  private async tableHasColumn(tableName: string, columnName: string): Promise<boolean> {
    const result = await this.db.runAndReadAll(
      `SELECT COUNT(*) AS c
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1
          AND column_name = $2;`,
      [tableName, columnName],
    );
    const value = result.getRowObjects()[0]?.c;
    return Number(value ?? 0) > 0;
  }

  /**
   * source_file_path 是 reset 的唯一归属边界。旧表没有该列时，历史行无法安全
   * 回填来源，必须在同一事务内清空投影与 watermark，随后由 JSONL 全量重建。
   * 迁移失败直接拒绝 initialize（fail-closed）；成功后重复调用不再改动数据。
   */
  private async ensureSourceFileProvenance(): Promise<void> {
    const info = (await this.db.runAndReadAll(`PRAGMA table_info('tool_audit');`)).getRowObjects();
    const sourceColumn = info.find((row) => String(row.name) === 'source_file_path');
    const sourceIsNotNull = sourceColumn?.notnull === true
      || sourceColumn?.notnull === 1
      || sourceColumn?.notnull === 1n;

    let preserveAttributedRows = sourceColumn !== undefined;
    if (sourceColumn) {
      const result = await this.db.runAndReadAll(
        `SELECT COUNT(*) AS c FROM tool_audit
          WHERE source_file_path IS NULL OR source_file_path = '';`,
      );
      preserveAttributedRows = Number(result.getRowObjects()[0]?.c ?? 0) === 0;
    }
    if (sourceColumn && sourceIsNotNull && preserveAttributedRows) return;

    await this.db.run('BEGIN TRANSACTION;');
    try {
      await this.db.run(`DROP TABLE IF EXISTS ${TOOL_AUDIT_MIGRATION_TABLE};`);
      await this.db.run(createToolAuditTableSql(TOOL_AUDIT_MIGRATION_TABLE));
      if (preserveAttributedRows) {
        await this.db.run(
          `INSERT INTO ${TOOL_AUDIT_MIGRATION_TABLE} (${TOOL_AUDIT_COLUMNS})
           SELECT ${TOOL_AUDIT_COLUMNS} FROM tool_audit;`,
        );
      }
      // 无 provenance 的行不可归属；任何 provenance schema 升级都清 watermark，
      // 确保后续 tick 从 JSONL 全量校准，而不是信任旧 offset。
      await this.db.run('DELETE FROM projection_watermark;');
      await this.db.run('DROP TABLE tool_audit;');
      await this.db.run(`ALTER TABLE ${TOOL_AUDIT_MIGRATION_TABLE} RENAME TO tool_audit;`);
      await this.db.run('COMMIT;');
    } catch (err) {
      await this.db.run('ROLLBACK;').catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to migrate tool_audit source provenance: ${message}`);
    }
  }

  private async ensureTenantScopedPrimaryKey(): Promise<void> {
    const info = (await this.db.runAndReadAll(`PRAGMA table_info('tool_audit');`)).getRowObjects();
    const primaryKeyColumns = info
      .filter((row) => row.pk === true || row.pk === 1 || row.pk === 1n)
      .map((row) => String(row.name))
      .sort();

    if (primaryKeyColumns.length === 2
      && primaryKeyColumns[0] === 'id'
      && primaryKeyColumns[1] === 'tenant_id') {
      return;
    }
    if (primaryKeyColumns.length !== 1 || primaryKeyColumns[0] !== 'id') {
      throw new Error(`Unsupported tool_audit primary key: ${primaryKeyColumns.join(',') || '(none)'}`);
    }

    await this.db.run('BEGIN TRANSACTION;');
    try {
      await this.db.run(createToolAuditTableSql(TOOL_AUDIT_MIGRATION_TABLE));
      await this.db.run(
        `INSERT INTO ${TOOL_AUDIT_MIGRATION_TABLE} (${TOOL_AUDIT_COLUMNS})
         SELECT ${TOOL_AUDIT_COLUMNS} FROM tool_audit;`,
      );
      await this.db.run('DROP TABLE tool_audit;');
      await this.db.run(`ALTER TABLE ${TOOL_AUDIT_MIGRATION_TABLE} RENAME TO tool_audit;`);
      await this.db.run('COMMIT;');
    } catch (err) {
      await this.db.run('ROLLBACK;').catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to migrate tool_audit to tenant-scoped primary key: ${message}`);
    }
  }

  /** 测试 / 强制全量重投：清空 audit + watermark。 */
  async clear(): Promise<void> {
    await this.db.run('DELETE FROM tool_audit;');
    await this.db.run('DELETE FROM projection_watermark;');
  }

  /**
   * 扫描 root 下所有 `*<RUNTIME_EVENTS_SUFFIX>`，对每个文件按 watermark 做增量投影。
   *
   * - 文件不存在的 watermark 条目不主动清理（保留观察证据，PoC 期不做 GC）。
   * - 单文件失败不阻塞其它文件，错误计入 `stats.errors` + `logger.warn`。
   */
  async tick(): Promise<TickStats> {
    const stats: TickStats = {
      filesScanned: 0,
      filesProjected: 0,
      eventsInserted: 0,
      resets: 0,
      errors: 0,
    };
    const files = await this.discoverFiles();
    for (const filePath of files) {
      stats.filesScanned += 1;
      try {
        const r = await this.tickFile(filePath);
        if (r.bytesRead > 0) stats.filesProjected += 1;
        stats.eventsInserted += r.eventsInserted;
        if (r.reset) stats.resets += 1;
      } catch (err) {
        stats.errors += 1;
        this.logger.warn?.('[audit projection] tickFile failed', {
          filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return stats;
  }

  /**
   * 单文件增量投影。
   *
   * - 文件不存在 → `bytesRead=0`，不报错（其它 session 还没产生 runtime-events 的常态）。
   * - `file.size < watermark.byte_offset` → 视为文件被截断/重置，仅 clear 该源文件
   *   的历史 audit + reset watermark + 从 0 重读。
   */
  async tickFile(filePath: string): Promise<TickFileResult> {
    let size: number;
    try {
      const s = await stat(filePath);
      size = s.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { bytesRead: 0, eventsInserted: 0, reset: false };
      }
      throw err;
    }

    const watermark = await this.readWatermark(filePath);
    let startOffset = watermark.byteOffset;
    let reset = false;
    if (size < watermark.byteOffset) {
      // provenance 是唯一删除边界；同 tenant/session 的其它源文件不受影响。
      await this.clearByFile(filePath);
      startOffset = 0;
      reset = true;
    }

    if (size === startOffset) {
      return { bytesRead: 0, eventsInserted: 0, reset };
    }

    const bytesRead = size - startOffset;
    const events = await this.readJsonlFrom(filePath, startOffset, size);

    let inserted = 0;
    if (events.length > 0) {
      inserted = await this.insertEvents(events, filePath);
    }

    const tenantIds = new Set(reset ? [] : watermark.tenantIds);
    for (const event of events) tenantIds.add(event.tenantId ?? LEGACY_TENANT_ID);
    await this.writeWatermark(filePath, size, [...tenantIds].sort());
    return { bytesRead, eventsInserted: inserted, reset };
  }

  // ── 内部 ─────────────────────────────────────────

  private async discoverFiles(): Promise<string[]> {
    const result: string[] = [];
    await this.collectRuntimeEventFiles(this.root, result);
    return result;
  }

  private async collectRuntimeEventFiles(dir: string, result: string[]): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.collectRuntimeEventFiles(full, result);
      } else if (entry.isFile() && entry.name.endsWith(RUNTIME_EVENTS_SUFFIX)) {
        result.push(full);
      }
    }
  }

  private async readWatermark(filePath: string): Promise<{ byteOffset: number; tenantIds: string[] }> {
    const result = await this.db.runAndReadAll(
      `SELECT byte_offset, tenant_ids_json FROM projection_watermark WHERE file_path = $1;`,
      [filePath],
    );
    const row = result.getRowObjects()[0];
    if (!row) return { byteOffset: 0, tenantIds: [] };
    const rawOffset = row.byte_offset;
    const byteOffset = typeof rawOffset === 'bigint' || typeof rawOffset === 'number'
      ? Number(rawOffset)
      : 0;
    let tenantIds: string[] = [];
    try {
      const parsed = JSON.parse(String(row.tenant_ids_json ?? '[]')) as unknown;
      if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string' && value.length > 0)) {
        tenantIds = [...new Set(parsed)];
      }
    } catch {
      throw new Error(`Invalid tenant boundary watermark for ${filePath}`);
    }
    return { byteOffset, tenantIds };
  }

  private async writeWatermark(filePath: string, byteOffset: number, tenantIds: string[]): Promise<void> {
    await this.db.run(
      `INSERT INTO projection_watermark (file_path, byte_offset, updated_at, tenant_ids_json)
       VALUES ($1, $2, CAST($3 AS TIMESTAMP), $4)
       ON CONFLICT (file_path) DO UPDATE SET
         byte_offset     = excluded.byte_offset,
         updated_at      = excluded.updated_at,
         tenant_ids_json = excluded.tenant_ids_json;`,
      [filePath, BigInt(byteOffset), new Date().toISOString(), JSON.stringify(tenantIds)],
    );
  }

  // 读 [offset, end) 区间字节，按行 parse、过滤 type === 'tool_audit'
  private async readJsonlFrom(filePath: string, offset: number, end: number): Promise<ToolAuditEvent[]> {
    const handle = await open(filePath, 'r');
    try {
      const len = end - offset;
      const buf = Buffer.alloc(len);
      let total = 0;
      while (total < len) {
        const { bytesRead } = await handle.read(buf, total, len - total, offset + total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      const text = buf.subarray(0, total).toString('utf-8');
      const out: ToolAuditEvent[] = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed) as PlatformEvent;
          if (evt.type === 'tool_audit') out.push(evt);
        } catch {
          // 容错：append-only 文件偶尔有半行（罕见），忽略
        }
      }
      return out;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async insertEvents(events: ToolAuditEvent[], sourceFilePath: string): Promise<number> {
    let inserted = 0;
    for (const e of events) {
      try {
        await this.db.run(
          `INSERT INTO tool_audit (
             id, timestamp, session_id, run_id, tenant_id, source_file_path,
             tool_call_id, tool_id, tool_name, skill_name, risk, approval_id,
             authorization_source, authorization_json, execution_target, status,
             duration_ms, execution_invocations_json, error,
             app_user_id, app_installation_id, app_capability_id, app_lcid, app_request_id,
             app_dig, app_input_hash, app_output_hash, app_output_bytes, app_error_code, app_origin
           ) VALUES (
             $1, CAST($2 AS TIMESTAMP), $3, $4, $5, $6,
             $7, $8, $9, $10, $11, $12,
             $13, $14, $15, $16,
             $17, $18, $19,
             $20, $21, $22, $23, $24,
             $25, $26, $27, $28, $29, $30
           ) ON CONFLICT (tenant_id, id) DO NOTHING;`,
          [
            e.id,
            e.timestamp,
            e.sessionId,
            e.runId,
            // PR 10：旧 jsonl 行没有 tenantId 字段 → 兜底 legacy tenant（写入路径已是必填）
            e.tenantId ?? LEGACY_TENANT_ID,
            sourceFilePath,
            e.toolCallId,
            e.toolId,
            e.toolName,
            e.skillName ?? null,
            e.risk,
            e.approvalId ?? null,
            e.authorization.source,
            JSON.stringify(e.authorization),
            e.executionTarget,
            e.status,
            BigInt(e.durationMs),
            e.executionInvocations ? JSON.stringify(e.executionInvocations) : null,
            e.error ?? null,
            e.userId ?? null,
            e.installationId ?? null,
            e.capabilityId ?? null,
            e.lcid ?? null,
            e.requestId ?? null,
            e.dig ?? null,
            e.inputHash ?? null,
            e.outputHash ?? null,
            e.outputBytes === undefined ? null : BigInt(e.outputBytes),
            e.errorCode ?? null,
            e.origin ?? null,
          ],
        );
        inserted += 1;
      } catch (err) {
        this.logger.warn?.('[audit projection] insert failed', {
          eventId: e.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return inserted;
  }

  /** 文件回退时仅清理该 JSONL 源文件产生的投影。 */
  private async clearByFile(filePath: string): Promise<void> {
    await this.db.run(
      'DELETE FROM tool_audit WHERE source_file_path = $1;',
      [filePath],
    );
  }
}

export function createAuditProjection(opts: CreateAuditProjectionOptions): AuditProjection {
  return new AuditProjection(opts.db, opts.root ?? ALLOWED_ROOT, opts.logger ?? {});
}
