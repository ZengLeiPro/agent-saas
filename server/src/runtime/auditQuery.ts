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
import { APP_CAPABILITY_AUDIT_KEYS, type AppCapabilityAuditFields } from './toolAuditEvent.js';

type ToolAuditEvent = Extract<PlatformEvent, { type: 'tool_audit' }>;

/** 只挑存在的键，保持「没有就不写这个键」的既有序列化语义。 */
function pickAppCapabilityAuditFields(
  source: Partial<AppCapabilityAuditFields>,
): AppCapabilityAuditFields {
  const picked: Record<string, unknown> = {};
  for (const key of APP_CAPABILITY_AUDIT_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== null) picked[key] = value;
  }
  return picked as AppCapabilityAuditFields;
}

/** DuckDB 列名 → `AppCapabilityAuditFields` 键。 */
const APP_AUDIT_COLUMN_BY_KEY = {
  userId: 'app_user_id',
  installationId: 'app_installation_id',
  capabilityId: 'app_capability_id',
  lcid: 'app_lcid',
  requestId: 'app_request_id',
  dig: 'app_dig',
  inputHash: 'app_input_hash',
  outputHash: 'app_output_hash',
  outputBytes: 'app_output_bytes',
  errorCode: 'app_error_code',
  origin: 'app_origin',
} as const satisfies Record<keyof AppCapabilityAuditFields, string>;

function readAppCapabilityAuditRow(row: Record<string, unknown>): AppCapabilityAuditFields {
  const entry: Record<string, unknown> = {};
  for (const key of APP_CAPABILITY_AUDIT_KEYS) {
    const value = row[APP_AUDIT_COLUMN_BY_KEY[key]];
    if (value === null || value === undefined || value === '') continue;
    entry[key] = key === 'outputBytes' ? Number(value) : String(value);
  }
  return entry as AppCapabilityAuditFields;
}

export interface RuntimeAuditEntry extends AppCapabilityAuditFields {
  id: string;
  timestamp: string;
  runId: string;
  sessionId: string;
  /** 组织 slug（PR 10）。旧 jsonl 没有时投影/读取均回退 LEGACY_TENANT_ID。 */
  tenantId: string;
  toolCallId: string;
  toolId: string;
  toolName: string;
  skillName?: string;
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
  /**
   * 强制组织边界。所有 Runtime Audit 调用（包括平台管理员）都必须显式提供；
   * 查询实现会在运行时再次校验，避免绕过路由后仅凭 sessionId/runId 查询。
   */
  tenantId: string;
  /** 截取返回数量（应用在 since/runId 过滤之后） */
  limit?: number;
  /** 跳过前 N 条（先 since/runId 过滤再 offset） */
  offset?: number;
  /** ISO 字符串；仅返回 `timestamp >= since` 的条目 */
  since?: string;
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
  listBySessionId(sessionId: string, options: AuditQueryOptions): Promise<RuntimeAuditEntry[]>;
  /** 以 tenantId + sessionId 为边界，在该 session 的 runtime-events 内按 runId 过滤。 */
  listByRunId(sessionId: string, runId: string, options: AuditQueryOptions): Promise<RuntimeAuditEntry[]>;
  summarize(sessionId: string, options: AuditQueryOptions): Promise<AuditSummary>;
  /**
   * 在显式 tenantId 切片内跨 session 按 runId 查询。EventStore backend 不提供
   * （缺省即 `undefined`），admin route 通过此可选性 type-guard 检测、在 file
   * 模式下返回 503。
   */
  listByRunIdGlobal?(runId: string, options: AuditQueryOptions): Promise<RuntimeAuditEntry[]>;
  /** tenant 切片内跨 session runId 的分布汇总 + 涉及 session 列表。 */
  summarizeByRunIdGlobal?(runId: string, options: AuditQueryOptions): Promise<AuditSummaryByRun>;
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
    ...(event.skillName ? { skillName: event.skillName } : {}),
    risk: event.risk,
    ...(event.approvalId ? { approvalId: event.approvalId } : {}),
    authorization: event.authorization,
    authorizationSource: event.authorization.source,
    executionTarget: event.executionTarget,
    status: event.status,
    durationMs: event.durationMs,
    ...(event.executionInvocations?.length ? { executionInvocations: event.executionInvocations } : {}),
    ...(event.error ? { error: event.error } : {}),
    // WP3 §6.2-8：定制项目能力调用的扩展字段原样透传（非 app__ 工具全为 undefined）。
    ...pickAppCapabilityAuditFields(event),
  };
}

/** 解析 since 为可比较的毫秒数；解析失败返回 null（视为不过滤） */
function parseSince(since: string | undefined): number | null {
  if (!since) return null;
  const t = Date.parse(since);
  return Number.isFinite(t) ? t : null;
}

function requireAuditTenant(options: AuditQueryOptions): string {
  const tenantId = options?.tenantId?.trim();
  if (!tenantId) throw new Error('Runtime Audit query requires tenantId');
  return tenantId;
}

function applyOptions(
  entries: RuntimeAuditEntry[],
  options: AuditQueryOptions,
): RuntimeAuditEntry[] {
  const tenantId = requireAuditTenant(options);
  let result = entries.filter((entry) => entry.tenantId === tenantId);
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

export type TranscriptPathResolver = (tenantId: string, sessionId: string) => Promise<string | null>;

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

  async listBySessionId(sessionId: string, options: AuditQueryOptions): Promise<RuntimeAuditEntry[]> {
    const tenantId = requireAuditTenant(options);
    const entries = await this.readEntries(tenantId, sessionId);
    return applyOptions(entries, options);
  }

  async listByRunId(sessionId: string, runId: string, options: AuditQueryOptions): Promise<RuntimeAuditEntry[]> {
    const tenantId = requireAuditTenant(options);
    const entries = await this.readEntries(tenantId, sessionId);
    const filtered = entries.filter((entry) => entry.runId === runId);
    return applyOptions(filtered, options);
  }

  async summarize(sessionId: string, options: AuditQueryOptions): Promise<AuditSummary> {
    const tenantId = requireAuditTenant(options);
    const all = await this.readEntries(tenantId, sessionId);
    const tenantFiltered = all.filter(e => e.tenantId === tenantId);
    const filtered = applyOptions(tenantFiltered, { tenantId, ...(options.since ? { since: options.since } : {}) });
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

  private async readEntries(tenantId: string, sessionId: string): Promise<RuntimeAuditEntry[]> {
    const transcriptPath = await this.transcriptResolver(tenantId, sessionId);
    if (!transcriptPath) return [];
    const eventLogPath = getRuntimeEventLogPath(transcriptPath);
    // transcriptResolver 已按 tenantId 定位到 tenant 物理目录；FileEventStore 仍显式绑定
    // 同一 tenant，避免未来切换到共享 backend 时把物理隔离误当作隐式默认租户。
    const store = this.options.createEventStore
      ? this.options.createEventStore(eventLogPath)
      : new FileEventStore(eventLogPath, tenantId);
    const events = await store.list(tenantId, sessionId);
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

  async listBySessionId(sessionId: string, options: AuditQueryOptions): Promise<RuntimeAuditEntry[]> {
    const tenantId = requireAuditTenant(options);
    await this.maybeTick();
    const where: string[] = ['session_id = $1'];
    const params: DuckDBValue[] =[sessionId];
    appendSince(where, params, options.since);
    appendTenant(where, params, tenantId);
    const sql = buildSelectSql(where, options);
    return this.runSelect(sql, params);
  }

  async listByRunId(sessionId: string, runId: string, options: AuditQueryOptions): Promise<RuntimeAuditEntry[]> {
    const tenantId = requireAuditTenant(options);
    await this.maybeTick();
    const where: string[] = ['session_id = $1', 'run_id = $2'];
    const params: DuckDBValue[] =[sessionId, runId];
    appendSince(where, params, options.since);
    appendTenant(where, params, tenantId);
    const sql = buildSelectSql(where, options);
    return this.runSelect(sql, params);
  }

  async summarize(sessionId: string, options: AuditQueryOptions): Promise<AuditSummary> {
    const tenantId = requireAuditTenant(options);
    await this.maybeTick();
    const baseParams: DuckDBValue[] = [sessionId, tenantId];
    const baseTenantClause = ' AND tenant_id = $2';

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
  async listByRunIdGlobal(runId: string, options: AuditQueryOptions): Promise<RuntimeAuditEntry[]> {
    const tenantId = requireAuditTenant(options);
    await this.maybeTick();
    const where: string[] = ['run_id = $1'];
    const params: DuckDBValue[] = [runId];
    appendSince(where, params, options.since);
    appendTenant(where, params, tenantId);
    const sql = buildSelectSql(where, options);
    return this.runSelect(sql, params);
  }

  /**
   * 跨 session runId 的汇总：分布 + 涉及的 session 列表。
   * `total` = 该 runId 全部条目；`filteredTotal` 应用 since 过滤后的条目。
   */
  async summarizeByRunIdGlobal(runId: string, options: AuditQueryOptions): Promise<AuditSummaryByRun> {
    const tenantId = requireAuditTenant(options);
    await this.maybeTick();
    const baseParams: DuckDBValue[] = [runId, tenantId];
    const baseTenantClause = ' AND tenant_id = $2';

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
  skill_name,
  risk,
  approval_id,
  authorization_source,
  authorization_json,
  execution_target,
  status,
  duration_ms,
  execution_invocations_json,
  error,
  app_user_id,
  app_installation_id,
  app_capability_id,
  app_lcid,
  app_request_id,
  app_dig,
  app_input_hash,
  app_output_hash,
  app_output_bytes,
  app_error_code,
  app_origin
`;

function buildSelectSql(whereClauses: string[], options: AuditQueryOptions): string {
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

/** 所有 DuckDB 查询都显式绑定 tenant_id，禁止无租户全局路径。 */
function appendTenant(where: string[], params: DuckDBValue[], tenantId: string): void {
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
  if (row.skill_name != null && row.skill_name !== '') {
    entry.skillName = String(row.skill_name);
  }
  if (executionInvocations && executionInvocations.length > 0) {
    entry.executionInvocations = executionInvocations;
  }
  if (row.error != null && row.error !== '') {
    entry.error = String(row.error);
  }
  Object.assign(entry, readAppCapabilityAuditRow(row as Record<string, unknown>));
  return entry;
}
