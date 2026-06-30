/**
 * Runtime audit projection (read-side)
 *
 * 两种 backend：
 *   - file   (默认)：EventStoreRuntimeAuditQuery — 从 `*.runtime-events.jsonl` 实时读
 *   - duckdb       ：DuckDBRuntimeAuditQuery     — 从 DuckDB 投影表读，每次 query 前
 *                    tick 一次增量
 *
 * 两个实现共享 `RuntimeAuditQuery` 接口，admin route 与上层不感知；config
 * `audit.projection` 灰度切换。同一份 audit 数据两个实现结果一致，见
 * verify:audit-read 双 backend 验证。
 *
 * 设计取舍（2026-06-07）：
 * - `listByRunId` 仍以 sessionId 为入口（与 EventStore 实现签名一致）；跨 session
 *   按 runId 全局查询见 commit 3 的 `listByRunIdGlobal`（DuckDB only），单独 endpoint。
 * - 顶层化 `approvalId / executionTarget / authorizationSource`，让消费方
 *   不必逐条 dig 进 `authorization` 子对象；原始 `authorization` 仍保留。
 */
import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';

import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import { FileEventStore, getRuntimeEventLogPath } from './fileEventStore.js';
import { LEGACY_TENANT_ID } from '../data/tenants/types.js';
import type { AuditProjection } from './auditProjection.js';
import type {
  EventStore,
  PlatformEvent,
} from './types.js';

type ToolAuditEvent = Extract<PlatformEvent, { type: 'tool_audit' }>;

export interface RuntimeAuditEntry {
  id: string;
  timestamp: string;
  runId: string;
  sessionId: string;
  /** 组织 slug（PR 10）。旧 jsonl 没有时投影/读取均回退 LEGACY_TENANT_ID。 */
  tenantId: string;
  toolCallId: string;
  toolId: string;
  toolName: string;
  risk: ToolAuditEvent['risk'];
  approvalId?: string;
  authorization: ToolAuditEvent['authorization'];
  /** 顶层化 `authorization.source`，方便 SQL/客户端按 source 聚合 */
  authorizationSource: ToolAuditEvent['authorization']['source'];
  executionTarget: ExecutionTargetKind;
  status: ToolAuditEvent['status'];
  durationMs: number;
  executionInvocations?: ToolAuditEvent['executionInvocations'];
  error?: string;
}

export interface AuditQueryOptions {
  /** 截取返回数量（应用在 since/runId 过滤之后） */
  limit?: number;
  /** 跳过前 N 条（先 since/runId 过滤再 offset） */
  offset?: number;
  /** ISO 字符串；仅返回 `timestamp >= since` 的条目 */
  since?: string;
  /**
   * 组织过滤（PR 10）。
   *   - undefined → 跨组织（仅平台 admin 用，路由层会传 undefined）
   *   - 具体 slug → 仅该组织；非平台 admin 必须传 caller.tenantId
   * EventStore backend 在内存里 filter；DuckDB backend SQL where 加 tenant_id = ?
   */
  tenantId?: string;
}

export interface AuditSummary {
  total: number;
  /** 截取/分页前的命中总数（按 since 过滤后） */
  filteredTotal: number;
  byExecutionTarget: Record<string, number>;
  byStatus: Record<'success' | 'error', number>;
  byAuthorizationSource: Record<string, number>;
}

/**
 * 跨 session 视角的 summary。
 *
 * 与单 session `AuditSummary` 同形 + 额外 `sessionIds` 字段，便于 admin 通过
 * runId 反查涉及的 session 列表。
 */
export interface AuditSummaryByRun extends AuditSummary {
  sessionIds: string[];
}

export interface RuntimeAuditQuery {
  listBySessionId(sessionId: string, options?: AuditQueryOptions): Promise<RuntimeAuditEntry[]>;
  /** 以 sessionId 为入口，在该 session 的 runtime-events 内按 runId 过滤。 */
  listByRunId(sessionId: string, runId: string, options?: AuditQueryOptions): Promise<RuntimeAuditEntry[]>;
  summarize(sessionId: string, options?: AuditQueryOptions): Promise<AuditSummary>;
  /**
   * 跨 session 按 runId 全局查询。仅 DuckDB backend 实现；EventStore backend
   * 不提供（缺省即 `undefined`），admin route 通过此可选性 type-guard 检测、
   * 在 file 模式下返回 503。
   */
  listByRunIdGlobal?(runId: string, options?: AuditQueryOptions): Promise<RuntimeAuditEntry[]>;
  /** 跨 session runId 的分布汇总 + 涉及 session 列表。同上仅 DuckDB 实现。 */
  summarizeByRunIdGlobal?(runId: string, options?: AuditQueryOptions): Promise<AuditSummaryByRun>;
}

/** 把 PlatformEvent.tool_audit 映射成对外的 RuntimeAuditEntry */
export function toRuntimeAuditEntry(event: ToolAuditEvent): RuntimeAuditEntry {
  return {
    id: event.id,
    timestamp: event.timestamp,
    runId: event.runId,
    sessionId: event.sessionId,
    // PR 10：旧 jsonl 行没有 tenantId 字段 → 视为 LEGACY_TENANT_ID（迁移前唯一组织）
    tenantId: event.tenantId ?? LEGACY_TENANT_ID,
    toolCallId: event.toolCallId,
    toolId: event.toolId,
    toolName: event.toolName,
    risk: event.risk,
    ...(event.approvalId ? { approvalId: event.approvalId } : {}),
    authorization: event.authorization,
    authorizationSource: event.authorization.source,
    executionTarget: event.executionTarget,
    status: event.status,
    durationMs: event.durationMs,
    ...(event.executionInvocations?.length ? { executionInvocations: event.executionInvocations } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
}

/** 解析 since 为可比较的毫秒数；解析失败返回 null（视为不过滤） */
function parseSince(since: string | undefined): number | null {
  if (!since) return null;
  const t = Date.parse(since);
  return Number.isFinite(t) ? t : null;
}

function applyOptions(
  entries: RuntimeAuditEntry[],
  options: AuditQueryOptions | undefined,
): RuntimeAuditEntry[] {
  if (!options) return entries;
  let result = entries;
  // PR 10：tenantId 过滤（EventStore backend 用内存 filter；DuckDB backend SQL where 处理）
  if (options.tenantId !== undefined) {
    const t = options.tenantId;
    result = result.filter((entry) => entry.tenantId === t);
  }
  const sinceMs = parseSince(options.since);
  if (sinceMs !== null) {
    result = result.filter((entry) => {
      const ts = Date.parse(entry.timestamp);
      return Number.isFinite(ts) && ts >= sinceMs;
    });
  }
  const offset = options.offset && options.offset > 0 ? Math.floor(options.offset) : 0;
  if (offset) result = result.slice(offset);
  if (options.limit !== undefined && options.limit >= 0) {
    result = result.slice(0, Math.floor(options.limit));
  }
  return result;
}

export type TranscriptPathResolver = (sessionId: string) => Promise<string | null>;

/**
 * 直接基于 FileEventStore 的 audit 查询实现。
 *
 * 通过 `transcriptResolver` 把 sessionId 转成 transcript path，再读
 * `getRuntimeEventLogPath(transcriptPath)` 指向的 jsonl 文件。
 *
 * 当 session 不存在 / runtime-events 文件缺失（旧 session 或还未跑过 raw runtime）
 * 时返回空数组，不抛错。
 */
export class EventStoreRuntimeAuditQuery implements RuntimeAuditQuery {
  constructor(
    private readonly transcriptResolver: TranscriptPathResolver,
    private readonly options: {
      /** 注入自定义 EventStore 工厂，便于测试 */
      createEventStore?: (eventLogPath: string) => EventStore;
    } = {},
  ) {}

  async listBySessionId(sessionId: string, options?: AuditQueryOptions): Promise<RuntimeAuditEntry[]> {
    const entries = await this.readEntries(sessionId);
    return applyOptions(entries, options);
  }

  async listByRunId(sessionId: string, runId: string, options?: AuditQueryOptions): Promise<RuntimeAuditEntry[]> {
    const entries = await this.readEntries(sessionId);
    const filtered = entries.filter((entry) => entry.runId === runId);
    return applyOptions(filtered, options);
  }

  async summarize(sessionId: string, options?: AuditQueryOptions): Promise<AuditSummary> {
    const all = await this.readEntries(sessionId);
    // PR 10：tenantId 过滤要在 total 与 filtered 中分别考虑——total 应为该 session
    // 在 caller 视野内的全部 entry（不含跨组织漏数），filtered 再叠加 since。
    const tenantFiltered = options?.tenantId !== undefined
      ? all.filter(e => e.tenantId === options.tenantId)
      : all;
    const filtered = applyOptions(tenantFiltered, options ? { since: options.since } : undefined);
    const summary: AuditSummary = {
      total: tenantFiltered.length,
      filteredTotal: filtered.length,
      byExecutionTarget: {},
      byStatus: { success: 0, error: 0 },
      byAuthorizationSource: {},
    };
    for (const entry of filtered) {
      summary.byExecutionTarget[entry.executionTarget] = (summary.byExecutionTarget[entry.executionTarget] ?? 0) + 1;
      summary.byStatus[entry.status] = (summary.byStatus[entry.status] ?? 0) + 1;
      summary.byAuthorizationSource[entry.authorizationSource] =
        (summary.byAuthorizationSource[entry.authorizationSource] ?? 0) + 1;
    }
    return summary;
  }

  private async readEntries(sessionId: string): Promise<RuntimeAuditEntry[]> {
    const transcriptPath = await this.transcriptResolver(sessionId);
    if (!transcriptPath) return [];
    const eventLogPath = getRuntimeEventLogPath(transcriptPath);
    const store = this.options.createEventStore
      ? this.options.createEventStore(eventLogPath)
      : new FileEventStore(eventLogPath);
    const events = await store.list(sessionId);
    const entries: RuntimeAuditEntry[] = [];
    for (const event of events) {
      if (event.type !== 'tool_audit') continue;
      // 防御：跨 session 错位（理论上不该发生，FileEventStore 是 per-session 文件）
      if (event.sessionId && event.sessionId !== sessionId) continue;
      entries.push(toRuntimeAuditEntry(event));
    }
    return entries;
  }
}

/**
 * 基于 DuckDB 投影表的 audit 查询实现。
 *
 * 与 `EventStoreRuntimeAuditQuery` 实现等价（同一份数据、同一份结果），区别在于：
 *   - 数据源：DuckDB 投影表，列存 + 索引，跨 session 聚合 / 时间窗筛远快于 jsonl 扫描
 *   - 实时性：每次 query 前自动调 `projection.tick()` 拉 jsonl 增量；保证读到最新写入
 *
 * tick 失败不阻塞查询（return 时使用现有 DB 数据）。增量代价 = 全部 jsonl 文件 stat
 * + 实际增量字节读 + INSERT；admin 偶尔 query 的负载下可接受。
 */
export class DuckDBRuntimeAuditQuery implements RuntimeAuditQuery {
  constructor(
    private readonly db: DuckDBConnection,
    private readonly projection: AuditProjection,
    private readonly tickBeforeQuery: boolean = true,
  ) {}

  async listBySessionId(sessionId: string, options?: AuditQueryOptions): Promise<RuntimeAuditEntry[]> {
    await this.maybeTick();
    const where: string[] = ['session_id = $1'];
    const params: DuckDBValue[] =[sessionId];
    appendSince(where, params, options?.since);
    appendTenant(where, params, options?.tenantId);
    const sql = buildSelectSql(where, options);
    return this.runSelect(sql, params);
  }

  async listByRunId(sessionId: string, runId: string, options?: AuditQueryOptions): Promise<RuntimeAuditEntry[]> {
    await this.maybeTick();
    const where: string[] = ['session_id = $1', 'run_id = $2'];
    const params: DuckDBValue[] =[sessionId, runId];
    appendSince(where, params, options?.since);
    appendTenant(where, params, options?.tenantId);
    const sql = buildSelectSql(where, options);
    return this.runSelect(sql, params);
  }

  async summarize(sessionId: string, options?: AuditQueryOptions): Promise<AuditSummary> {
    await this.maybeTick();

    // PR 10：tenantId 入参——total / filteredTotal / 各 GROUP BY 全部按 tenant 切片
    const baseParams: DuckDBValue[] = [sessionId];
    let baseTenantClause = '';
    if (options?.tenantId !== undefined) {
      baseParams.push(options.tenantId);
      baseTenantClause = ` AND tenant_id = $${baseParams.length}`;
    }

    const totalResult = await this.db.runAndReadAll(
      `SELECT COUNT(*) AS c FROM tool_audit WHERE session_id = $1${baseTenantClause};`,
      baseParams,
    );
    const total = readCount(totalResult.getRowObjects()[0]?.c);

    const params: DuckDBValue[] = [...baseParams];
    let sinceClause = '';
    const sinceIso = parseSinceIso(options?.since);
    if (sinceIso) {
      params.push(sinceIso);
      sinceClause = ` AND timestamp >= CAST($${params.length} AS TIMESTAMP)`;
    }

    const filteredResult = await this.db.runAndReadAll(
      `SELECT COUNT(*) AS c FROM tool_audit WHERE session_id = $1${baseTenantClause}${sinceClause};`,
      params,
    );
    const filteredTotal = readCount(filteredResult.getRowObjects()[0]?.c);

    const summary: AuditSummary = {
      total,
      filteredTotal,
      byExecutionTarget: {},
      byStatus: { success: 0, error: 0 },
      byAuthorizationSource: {},
    };

    const targetRows = (await this.db.runAndReadAll(
      `SELECT execution_target AS k, COUNT(*) AS c FROM tool_audit
        WHERE session_id = $1${baseTenantClause}${sinceClause}
        GROUP BY execution_target;`,
      params,
    )).getRowObjects();
    for (const row of targetRows) {
      const k = String(row.k ?? '');
      summary.byExecutionTarget[k] = readCount(row.c);
    }

    const statusRows = (await this.db.runAndReadAll(
      `SELECT status AS k, COUNT(*) AS c FROM tool_audit
        WHERE session_id = $1${baseTenantClause}${sinceClause}
        GROUP BY status;`,
      params,
    )).getRowObjects();
    for (const row of statusRows) {
      const k = String(row.k ?? '');
      if (k === 'success' || k === 'error') {
        summary.byStatus[k] = readCount(row.c);
      }
    }

    const sourceRows = (await this.db.runAndReadAll(
      `SELECT authorization_source AS k, COUNT(*) AS c FROM tool_audit
        WHERE session_id = $1${baseTenantClause}${sinceClause}
        GROUP BY authorization_source;`,
      params,
    )).getRowObjects();
    for (const row of sourceRows) {
      const k = String(row.k ?? '');
      summary.byAuthorizationSource[k] = readCount(row.c);
    }

    return summary;
  }

  /**
   * 跨 session 按 runId 全局查询。投影表里 run_id 没有强 cross-session 唯一性
   * 约束（不同 session 理论可以撞同名 runId，虽然现状 randomUUID 不会），
   * 该接口按 run_id 直查，不限 session_id。
   */
  async listByRunIdGlobal(runId: string, options?: AuditQueryOptions): Promise<RuntimeAuditEntry[]> {
    await this.maybeTick();
    const where: string[] = ['run_id = $1'];
    const params: DuckDBValue[] = [runId];
    appendSince(where, params, options?.since);
    // PR 10：listByRunIdGlobal 的名字会让 caller 误以为它跨组织，但实际仅平台 admin 可调
    // （路由层判定）。当 caller 是组织 admin 时路由层会传 tenantId 强制限本组织。
    appendTenant(where, params, options?.tenantId);
    const sql = buildSelectSql(where, options);
    return this.runSelect(sql, params);
  }

  /**
   * 跨 session runId 的汇总：分布 + 涉及的 session 列表。
   * `total` = 该 runId 全部条目；`filteredTotal` 应用 since 过滤后的条目。
   */
  async summarizeByRunIdGlobal(runId: string, options?: AuditQueryOptions): Promise<AuditSummaryByRun> {
    await this.maybeTick();

    // PR 10：tenantId 切片 — total / filteredTotal / sessionIds / 各分布都按 caller 视野
    const baseParams: DuckDBValue[] = [runId];
    let baseTenantClause = '';
    if (options?.tenantId !== undefined) {
      baseParams.push(options.tenantId);
      baseTenantClause = ` AND tenant_id = $${baseParams.length}`;
    }

    const totalResult = await this.db.runAndReadAll(
      `SELECT COUNT(*) AS c FROM tool_audit WHERE run_id = $1${baseTenantClause};`,
      baseParams,
    );
    const total = readCount(totalResult.getRowObjects()[0]?.c);

    const params: DuckDBValue[] = [...baseParams];
    let sinceClause = '';
    const sinceIso = parseSinceIso(options?.since);
    if (sinceIso) {
      params.push(sinceIso);
      sinceClause = ` AND timestamp >= CAST($${params.length} AS TIMESTAMP)`;
    }

    const filteredResult = await this.db.runAndReadAll(
      `SELECT COUNT(*) AS c FROM tool_audit WHERE run_id = $1${baseTenantClause}${sinceClause};`,
      params,
    );
    const filteredTotal = readCount(filteredResult.getRowObjects()[0]?.c);

    const summary: AuditSummaryByRun = {
      total,
      filteredTotal,
      sessionIds: [],
      byExecutionTarget: {},
      byStatus: { success: 0, error: 0 },
      byAuthorizationSource: {},
    };

    // sessionIds 用未带 since 的 run_id 集合（admin 排查 "这个 run 跨了哪些
    // session" 不希望被 since 切掉），但 tenant 切片必须保留——组织 admin
    // 不应看到其他组织的 sessionId。
    const sessionRows = (await this.db.runAndReadAll(
      `SELECT DISTINCT session_id FROM tool_audit WHERE run_id = $1${baseTenantClause} ORDER BY session_id;`,
      baseParams,
    )).getRowObjects();
    summary.sessionIds = sessionRows.map((row) => String(row.session_id));

    const targetRows = (await this.db.runAndReadAll(
      `SELECT execution_target AS k, COUNT(*) AS c FROM tool_audit
        WHERE run_id = $1${baseTenantClause}${sinceClause}
        GROUP BY execution_target;`,
      params,
    )).getRowObjects();
    for (const row of targetRows) {
      summary.byExecutionTarget[String(row.k ?? '')] = readCount(row.c);
    }

    const statusRows = (await this.db.runAndReadAll(
      `SELECT status AS k, COUNT(*) AS c FROM tool_audit
        WHERE run_id = $1${baseTenantClause}${sinceClause}
        GROUP BY status;`,
      params,
    )).getRowObjects();
    for (const row of statusRows) {
      const k = String(row.k ?? '');
      if (k === 'success' || k === 'error') {
        summary.byStatus[k] = readCount(row.c);
      }
    }

    const sourceRows = (await this.db.runAndReadAll(
      `SELECT authorization_source AS k, COUNT(*) AS c FROM tool_audit
        WHERE run_id = $1${baseTenantClause}${sinceClause}
        GROUP BY authorization_source;`,
      params,
    )).getRowObjects();
    for (const row of sourceRows) {
      summary.byAuthorizationSource[String(row.k ?? '')] = readCount(row.c);
    }

    return summary;
  }

  private async maybeTick(): Promise<void> {
    if (!this.tickBeforeQuery) return;
    try {
      await this.projection.tick();
    } catch {
      // tick 失败不阻塞读：现有数据仍可服务
    }
  }

  private async runSelect(sql: string, params: DuckDBValue[]): Promise<RuntimeAuditEntry[]> {
    const rows = (await this.db.runAndReadAll(sql, params)).getRowObjects();
    return rows.map(rowToRuntimeAuditEntry);
  }
}

// ── DuckDB row 映射 ─────────────────────────────────────

const SELECT_COLUMNS = `
  id,
  strftime(timestamp, '%Y-%m-%dT%H:%M:%S.%g') || 'Z' AS timestamp_iso,
  session_id,
  run_id,
  tenant_id,
  tool_call_id,
  tool_id,
  tool_name,
  risk,
  approval_id,
  authorization_source,
  authorization_json,
  execution_target,
  status,
  duration_ms,
  execution_invocations_json,
  error
`;

function buildSelectSql(whereClauses: string[], options: AuditQueryOptions | undefined): string {
  const where = whereClauses.join(' AND ');
  let sql = `SELECT ${SELECT_COLUMNS} FROM tool_audit WHERE ${where} ORDER BY timestamp ASC`;
  const limit = options?.limit;
  const offset = options?.offset;
  if (typeof offset === 'number' && offset > 0) {
    sql += ` OFFSET ${Math.floor(offset)}`;
  }
  if (typeof limit === 'number' && limit >= 0) {
    sql += ` LIMIT ${Math.floor(limit)}`;
  }
  return sql + ';';
}

function appendSince(where: string[], params: DuckDBValue[], since: string | undefined): void {
  const iso = parseSinceIso(since);
  if (!iso) return;
  params.push(iso);
  where.push(`timestamp >= CAST($${params.length} AS TIMESTAMP)`);
}

/** PR 10：把 tenantId 入参追加到 where + params。undefined 不追加（跨组织视角，仅平台 admin 用） */
function appendTenant(where: string[], params: DuckDBValue[], tenantId: string | undefined): void {
  if (tenantId === undefined) return;
  params.push(tenantId);
  where.push(`tenant_id = $${params.length}`);
}

function parseSinceIso(since: string | undefined): string | null {
  if (!since) return null;
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

function readCount(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  return Number(v ?? 0);
}

function rowToRuntimeAuditEntry(row: Record<string, unknown>): RuntimeAuditEntry {
  const authorization = JSON.parse(String(row.authorization_json ?? '{}')) as RuntimeAuditEntry['authorization'];
  const executionInvocations = row.execution_invocations_json != null && row.execution_invocations_json !== ''
    ? JSON.parse(String(row.execution_invocations_json)) as RuntimeAuditEntry['executionInvocations']
    : undefined;

  const entry: RuntimeAuditEntry = {
    id: String(row.id),
    timestamp: String(row.timestamp_iso),
    runId: String(row.run_id),
    sessionId: String(row.session_id),
    // PR 10：tenant_id 列用 LEGACY_TENANT_ID 升级旧行；这里防御性兜底同口径。
    tenantId: row.tenant_id ? String(row.tenant_id) : LEGACY_TENANT_ID,
    toolCallId: String(row.tool_call_id),
    toolId: String(row.tool_id),
    toolName: String(row.tool_name),
    risk: String(row.risk) as RuntimeAuditEntry['risk'],
    authorization,
    authorizationSource: String(row.authorization_source) as RuntimeAuditEntry['authorizationSource'],
    executionTarget: String(row.execution_target) as ExecutionTargetKind,
    status: String(row.status) as RuntimeAuditEntry['status'],
    durationMs: readCount(row.duration_ms),
  };
  if (row.approval_id != null && row.approval_id !== '') {
    entry.approvalId = String(row.approval_id);
  }
  if (executionInvocations && executionInvocations.length > 0) {
    entry.executionInvocations = executionInvocations;
  }
  if (row.error != null && row.error !== '') {
    entry.error = String(row.error);
  }
  return entry;
}
