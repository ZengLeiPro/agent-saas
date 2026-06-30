/**
 * Runtime audit projection (read-side) — PostgreSQL backend
 *
 * 复用 PgEventStore 的 pool + eventsTable，从 `runtime_events` 表里直接查
 * `event_type = 'tool_audit'` 的事件，反序列化 `event_json` 后通过
 * `toRuntimeAuditEntry()` 映射到对外的 `RuntimeAuditEntry`。
 *
 * 与 `DuckDBRuntimeAuditQuery` 行为等价（同一份接口、同一份字段），区别：
 *   - 数据源：PG `runtime_events.event_json` (JSONB)，PG 是事实源
 *   - 跨 session：天然支持（`runtime_events_run_idx` 部分索引覆盖 run_id）
 *   - 实时性：无 watermark / tick 概念，PG 直读即最新
 *
 * 装配位置：`server/src/app/runtime.ts`。当 `runtimeEventStore.backend='pg'`
 * 时强制走此实现，`audit.projection` 字段在 PG backend 下被忽略
 * （因为 file/duckdb 两个实现都依赖磁盘 jsonl，事件已经不在那里了）。
 *
 * 设计取舍（2026-06-14 Stage 2.4b）：
 *   - 不再起第二个 DuckDB 投影层：PG 自己就是强 query 引擎，再上 DuckDB 是
 *     over-engineering，而且 PG → DuckDB 增量同步语义本身就难写对。
 *   - 复用同一个 `pg.Pool`：避免为只读路径再开一份连接池；shutdown 由
 *     `PgEventStore.close()` 统一负责。
 *   - JSONB 路径直接 GROUP BY：`event_json->>'executionTarget'` 等。tool_audit
 *     量级（admin 偶尔查）不需要为聚合再建表达式索引；真要加按 PR 拉动。
 */
import type pg from 'pg';

import type {
  AuditQueryOptions,
  AuditSummary,
  AuditSummaryByRun,
  RuntimeAuditEntry,
  RuntimeAuditQuery,
} from './auditQuery.js';
import { toRuntimeAuditEntry } from './auditQuery.js';
import type { PlatformEvent } from './types.js';

type ToolAuditEvent = Extract<PlatformEvent, { type: 'tool_audit' }>;

export interface PgRuntimeAuditQueryOptions {
  pool: pg.Pool;
  /** 与 `PgEventStore.eventsTable` 共用，调用方负责传入正确表名 */
  eventsTable: string;
}

export class PgRuntimeAuditQuery implements RuntimeAuditQuery {
  private readonly pool: pg.Pool;
  private readonly eventsTable: string;

  constructor(options: PgRuntimeAuditQueryOptions) {
    this.pool = options.pool;
    this.eventsTable = options.eventsTable;
  }

  async listBySessionId(sessionId: string, options?: AuditQueryOptions): Promise<RuntimeAuditEntry[]> {
    const where = ['session_id = $1', `event_type = 'tool_audit'`];
    const params: unknown[] = [sessionId];
    appendSinceParam(where, params, options?.since);
    return await this.runList(where, params, options);
  }

  async listByRunId(sessionId: string, runId: string, options?: AuditQueryOptions): Promise<RuntimeAuditEntry[]> {
    const where = ['session_id = $1', 'run_id = $2', `event_type = 'tool_audit'`];
    const params: unknown[] = [sessionId, runId];
    appendSinceParam(where, params, options?.since);
    return await this.runList(where, params, options);
  }

  async listByRunIdGlobal(runId: string, options?: AuditQueryOptions): Promise<RuntimeAuditEntry[]> {
    const where = ['run_id = $1', `event_type = 'tool_audit'`];
    const params: unknown[] = [runId];
    appendSinceParam(where, params, options?.since);
    return await this.runList(where, params, options);
  }

  async summarize(sessionId: string, options?: AuditQueryOptions): Promise<AuditSummary> {
    return await this.runSummarize(['session_id = $1'], [sessionId], options);
  }

  async summarizeByRunIdGlobal(runId: string, options?: AuditQueryOptions): Promise<AuditSummaryByRun> {
    const summary = await this.runSummarize(['run_id = $1'], [runId], options);
    // sessionIds 用不带 since 的 run_id 集合（admin 想看 "这个 run 跨了哪些
    // session" 不希望被 since 切掉），与 DuckDB 实现语义对齐。
    const sessionRows = await this.pool.query<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM ${this.eventsTable}
        WHERE run_id = $1 AND event_type = 'tool_audit'
        ORDER BY session_id ASC`,
      [runId],
    );
    return {
      ...summary,
      sessionIds: sessionRows.rows.map((row) => row.session_id),
    };
  }

  // ── 内部 ────────────────────────────────────────────

  private async runList(
    where: string[],
    params: unknown[],
    options: AuditQueryOptions | undefined,
  ): Promise<RuntimeAuditEntry[]> {
    let sql = `SELECT event_json FROM ${this.eventsTable}
      WHERE ${where.join(' AND ')}
      ORDER BY timestamp ASC, global_sequence ASC`;
    const offset = options?.offset && options.offset > 0 ? Math.floor(options.offset) : 0;
    if (offset) sql += ` OFFSET ${offset}`;
    if (options?.limit !== undefined && options.limit >= 0) {
      sql += ` LIMIT ${Math.floor(options.limit)}`;
    }
    const result = await this.pool.query<{ event_json: unknown }>(sql, params);
    const out: RuntimeAuditEntry[] = [];
    for (const row of result.rows) {
      const evt = normalizeToolAuditJson(row.event_json);
      if (!evt) continue;
      out.push(toRuntimeAuditEntry(evt));
    }
    return out;
  }

  private async runSummarize(
    keyClauses: string[],
    keyParams: unknown[],
    options: AuditQueryOptions | undefined,
  ): Promise<AuditSummary> {
    const base = keyClauses.concat([`event_type = 'tool_audit'`]);
    const baseWhereSql = base.join(' AND ');

    // total = 不带 since 的全部 count（与 DuckDB 行为对齐）
    const totalResult = await this.pool.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM ${this.eventsTable} WHERE ${baseWhereSql}`,
      keyParams,
    );
    const total = readCount(totalResult.rows[0]?.c);

    // filteredTotal 与各 GROUP BY 共享应用 since 后的 where + params
    const filteredWhere = [...base];
    const filteredParams = [...keyParams];
    appendSinceParam(filteredWhere, filteredParams, options?.since);
    const filteredWhereSql = filteredWhere.join(' AND ');

    const filteredResult = await this.pool.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM ${this.eventsTable} WHERE ${filteredWhereSql}`,
      filteredParams,
    );
    const filteredTotal = readCount(filteredResult.rows[0]?.c);

    const summary: AuditSummary = {
      total,
      filteredTotal,
      byExecutionTarget: {},
      byStatus: { success: 0, error: 0 },
      byAuthorizationSource: {},
    };

    // JSONB 路径取值聚合
    const targetRows = await this.pool.query<{ k: string | null; c: string }>(
      `SELECT event_json->>'executionTarget' AS k, COUNT(*) AS c
         FROM ${this.eventsTable}
        WHERE ${filteredWhereSql}
        GROUP BY event_json->>'executionTarget'`,
      filteredParams,
    );
    for (const row of targetRows.rows) {
      if (row.k != null) summary.byExecutionTarget[row.k] = readCount(row.c);
    }

    const statusRows = await this.pool.query<{ k: string | null; c: string }>(
      `SELECT event_json->>'status' AS k, COUNT(*) AS c
         FROM ${this.eventsTable}
        WHERE ${filteredWhereSql}
        GROUP BY event_json->>'status'`,
      filteredParams,
    );
    for (const row of statusRows.rows) {
      const k = row.k ?? '';
      if (k === 'success' || k === 'error') {
        summary.byStatus[k] = readCount(row.c);
      }
    }

    const sourceRows = await this.pool.query<{ k: string | null; c: string }>(
      `SELECT event_json->'authorization'->>'source' AS k, COUNT(*) AS c
         FROM ${this.eventsTable}
        WHERE ${filteredWhereSql}
        GROUP BY event_json->'authorization'->>'source'`,
      filteredParams,
    );
    for (const row of sourceRows.rows) {
      if (row.k != null) summary.byAuthorizationSource[row.k] = readCount(row.c);
    }

    return summary;
  }
}

function appendSinceParam(where: string[], params: unknown[], since: string | undefined): void {
  if (!since) return;
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return;
  params.push(new Date(t).toISOString());
  where.push(`timestamp >= $${params.length}::timestamptz`);
}

function readCount(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number.parseInt(v, 10) || 0;
  return 0;
}

/**
 * pg 驱动默认会把 JSONB 列自动解析成 JS 对象，但为了 verify 直连脚本与历史
 * 数据互通，仍兼容字符串形态。
 */
function normalizeToolAuditJson(raw: unknown): ToolAuditEvent | null {
  let parsed: unknown;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  } else {
    parsed = raw;
  }
  if (parsed && typeof parsed === 'object' && (parsed as PlatformEvent).type === 'tool_audit') {
    return parsed as ToolAuditEvent;
  }
  return null;
}
