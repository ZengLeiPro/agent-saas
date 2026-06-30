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

const SCHEMA_TOOL_AUDIT = `
CREATE TABLE IF NOT EXISTS tool_audit (
  id            VARCHAR PRIMARY KEY,
  timestamp     TIMESTAMP NOT NULL,
  session_id    VARCHAR   NOT NULL,
  run_id        VARCHAR   NOT NULL,
  -- PR 10：跨组织隔离投影列。新建表默认含本列；旧表升级走 ALTER TABLE
  -- IF NOT EXISTS（DuckDB 0.10+ 支持）。投影时若 event.tenantId 缺失（旧 jsonl）回填 legacy tenant。
  tenant_id     VARCHAR   NOT NULL DEFAULT '${LEGACY_TENANT_ID}',
  tool_call_id  VARCHAR   NOT NULL,
  tool_id       VARCHAR   NOT NULL,
  tool_name     VARCHAR   NOT NULL,
  risk          VARCHAR   NOT NULL,
  approval_id   VARCHAR,
  authorization_source       VARCHAR NOT NULL,
  authorization_json         VARCHAR NOT NULL,
  execution_target           VARCHAR NOT NULL,
  status                     VARCHAR NOT NULL,
  duration_ms                BIGINT  NOT NULL,
  execution_invocations_json VARCHAR,
  error                      VARCHAR
);
`;

/** PR 10：旧 DuckDB 文件升级路径——idempotent ALTER TABLE。DuckDB 0.10+ 支持 IF NOT EXISTS。 */
const ALTER_TOOL_AUDIT_TENANT = `
ALTER TABLE tool_audit ADD COLUMN IF NOT EXISTS tenant_id VARCHAR NOT NULL DEFAULT '${LEGACY_TENANT_ID}';
`;

const SCHEMA_WATERMARK = `
CREATE TABLE IF NOT EXISTS projection_watermark (
  file_path   VARCHAR PRIMARY KEY,
  byte_offset BIGINT  NOT NULL,
  updated_at  TIMESTAMP NOT NULL
);
`;

const SCHEMA_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_session     ON tool_audit(session_id);`,
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_run         ON tool_audit(run_id);`,
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_ts          ON tool_audit(timestamp);`,
  // PR 10：(tenant, *) 复合索引为 admin 跨 session / 跨 runId 加 tenantId where 提速
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_tenant_run  ON tool_audit(tenant_id, run_id);`,
  `CREATE INDEX IF NOT EXISTS idx_tool_audit_tenant_sess ON tool_audit(tenant_id, session_id);`,
];

export class AuditProjection {
  constructor(
    private readonly db: DuckDBConnection,
    private readonly root: string,
    private readonly logger: AuditProjectionLogger,
  ) {}

  /** 创建 schema + 索引；调用多次安全。 */
  async initialize(): Promise<void> {
    await this.db.run(SCHEMA_TOOL_AUDIT);
    await this.db.run(SCHEMA_WATERMARK);
    // PR 10：升级路径——旧 DuckDB 文件没有 tenant_id 列。CREATE TABLE IF NOT EXISTS
    // 只对新建生效；旧表需要 ALTER TABLE ADD COLUMN IF NOT EXISTS 兜底。
    try {
      await this.db.run(ALTER_TOOL_AUDIT_TENANT);
    } catch (err) {
      // ALTER 失败（不太可能）记录但不阻塞——SCHEMA_TOOL_AUDIT 已保证新建表有该列
      this.logger.warn?.('[audit projection] ALTER tool_audit ADD tenant_id failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    for (const ddl of SCHEMA_INDEXES) {
      await this.db.run(ddl);
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
   * - `file.size < watermark.byte_offset` → 视为文件被截断/重置，clear 该文件对应
   *   session 的历史 audit + reset watermark + 从 0 重读。
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
    let startOffset = watermark;
    let reset = false;
    if (size < watermark) {
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
      inserted = await this.insertEvents(events);
    }

    await this.writeWatermark(filePath, size);
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

  private async readWatermark(filePath: string): Promise<number> {
    const result = await this.db.runAndReadAll(
      `SELECT byte_offset FROM projection_watermark WHERE file_path = $1;`,
      [filePath],
    );
    const rows = result.getRowObjects();
    if (rows.length === 0) return 0;
    const v = rows[0]?.byte_offset;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'number') return v;
    return 0;
  }

  private async writeWatermark(filePath: string, byteOffset: number): Promise<void> {
    await this.db.run(
      `INSERT INTO projection_watermark (file_path, byte_offset, updated_at)
       VALUES ($1, $2, CAST($3 AS TIMESTAMP))
       ON CONFLICT (file_path) DO UPDATE SET
         byte_offset = excluded.byte_offset,
         updated_at  = excluded.updated_at;`,
      [filePath, BigInt(byteOffset), new Date().toISOString()],
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

  private async insertEvents(events: ToolAuditEvent[]): Promise<number> {
    let inserted = 0;
    for (const e of events) {
      try {
        await this.db.run(
          `INSERT INTO tool_audit (
             id, timestamp, session_id, run_id, tenant_id, tool_call_id, tool_id, tool_name,
             risk, approval_id, authorization_source, authorization_json,
             execution_target, status, duration_ms,
             execution_invocations_json, error
           ) VALUES (
             $1, CAST($2 AS TIMESTAMP), $3, $4, $5, $6, $7, $8,
             $9, $10, $11, $12,
             $13, $14, $15,
             $16, $17
           ) ON CONFLICT (id) DO NOTHING;`,
          [
            e.id,
            e.timestamp,
            e.sessionId,
            e.runId,
            // PR 10：旧 jsonl 行没有 tenantId 字段 → 兜底 legacy tenant（写入路径已是必填）
            e.tenantId ?? LEGACY_TENANT_ID,
            e.toolCallId,
            e.toolId,
            e.toolName,
            e.risk,
            e.approvalId ?? null,
            e.authorization.source,
            JSON.stringify(e.authorization),
            e.executionTarget,
            e.status,
            BigInt(e.durationMs),
            e.executionInvocations ? JSON.stringify(e.executionInvocations) : null,
            e.error ?? null,
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

  /**
   * 文件回退时清掉该文件对应 session 的 audit 历史。
   *
   * 当前 schema 没记 `file_path` 维度，所以按 "文件名 = `<sessionId>.runtime-events.jsonl`"
   * 反推 sessionId 做条件 delete。FileEventStore 现有约定保证 1 file ↔ 1 session。
   */
  private async clearByFile(filePath: string): Promise<void> {
    const base = filePath.split('/').pop() ?? '';
    const sid = base.endsWith(RUNTIME_EVENTS_SUFFIX)
      ? base.slice(0, -RUNTIME_EVENTS_SUFFIX.length)
      : '';
    if (!sid) return;
    await this.db.run('DELETE FROM tool_audit WHERE session_id = $1;', [sid]);
  }
}

export function createAuditProjection(opts: CreateAuditProjectionOptions): AuditProjection {
  return new AuditProjection(opts.db, opts.root ?? ALLOWED_ROOT, opts.logger ?? {});
}
