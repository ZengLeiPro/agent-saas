/**
 * Agent 运行监测效率聚合查询（PG runtime backend 专用）
 *
 * 供 /api/admin/runtime/trace 的 /recent-runs 与 /efficiency 端点使用：
 *   - listRecentRuns：直查 runtime_runs（按 updated_at DESC，status 白名单在路由层校验）
 *   - getEfficiency：时间窗内的结局/工具/成本/长尾/审批/浪费六组聚合
 *
 * 设计取舍：
 * - 所有 SQL 限定 timestamp/created_at >= $1（时间窗），tenant_id 可选过滤（走
 *   (tenant_id, timestamp DESC) 索引）；全参数化，绝不拼接用户输入。
 * - 表名来自现有 store 实例（PgEventStore.eventsTable / PgRunStore.runsTable /
 *   PgBillingStore.usageEventsTable），构造时再做一次 identifier 白名单校验兜底。
 * - waste 三个查询较重（jsonb_array_elements 展开 + 窗口函数），顺序执行，正确性
 *   优先于优雅；每条 SQL 头部带 "eff:xxx" 注释标记，便于 mock 测试与线上定位。
 * - repeatedFileReads 的文件路径从 toolCalls[].arguments（JSON 字符串）解析。
 *   SQL 侧不做 `::jsonb` 转型——单条截断/非法 JSON 会 500 掉整个聚合；改为
 *   SQL 按 (run_id, md5(arguments)) 分组取样本，Node 侧 JSON.parse 提取 path
 *   （兼容 path / file_path 两种参数名，对齐 toolRuntime 的取参逻辑）。
 * - PG bigint/numeric 经 pg 驱动返回字符串，所有 rows→response 转换收敛到本文件
 *   底部的纯函数（导出供单测）。所有除法防 0（分母为 0 时返回 null）。
 */

export interface EfficiencyQueryPool {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface RuntimeEfficiencyQueryOptions {
  pool: EfficiencyQueryPool;
  /** runtime_events 表名（从 PgEventStore.eventsTable 取） */
  eventsTable: string;
  /** runtime_runs 表名（从 PgRunStore.runsTable 取） */
  runsTable: string;
  /** runtime_billing_usage_events 表名（从 PgBillingStore.usageEventsTable 取） */
  billingUsageEventsTable: string;
}

export interface RecentRunsQueryOptions {
  /** 状态过滤（路由层已按白名单校验）。空/未传 = 不过滤。 */
  statuses?: string[];
  /** 回看小时数（路由层保证 1..720）。 */
  hours: number;
  /** 返回条数（路由层保证 1..200）。 */
  limit: number;
  tenantId?: string;
}

export interface RecentRunSummary {
  runId: string;
  sessionId: string;
  tenantId: string | null;
  userId: string | null;
  status: string;
  statusReason: string | null;
  model: string | null;
  channel: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  /** 终态耗时（终态时间戳 - started_at），能算则算。 */
  durationMs?: number;
}

export interface EfficiencyQueryOptions {
  /** 回看天数（路由层保证 1..30）。 */
  days: number;
  tenantId?: string;
}

export interface EfficiencyReport {
  range: { from: string; to: string; days: number };
  tenantId: string | null;
  outcome: {
    totalRuns: number;
    success: number;
    error: number;
    interrupted: number;
    /** success / total；total=0 时 null。 */
    completionRate: number | null;
    errorReasons: Array<{ reason: string; count: number; sampleRunId: string | null }>;
  };
  tools: {
    byTool: Array<{
      toolName: string;
      calls: number;
      errors: number;
      errorRate: number | null;
      totalDurationMs: number;
      avgDurationMs: number | null;
    }>;
    handFailures: number;
  };
  cost: {
    totalCostYuan: number;
    byModel: Array<{
      model: string;
      costYuan: number;
      requests: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      /** cached / input；input=0 时 null。 */
      cacheHitRate: number | null;
    }>;
    /** 每 run 成本（元）分位；无数据时各分位为 null。 */
    perRun: { p50: number | null; p90: number | null; p99: number | null };
    failedRunsCostYuan: number;
    cacheHitRate: number | null;
  };
  longTail: {
    slowestRuns: Array<{
      runId: string;
      sessionId: string;
      tenantId: string | null;
      durationMs: number;
      status: string;
      model: string | null;
    }>;
    mostTurns: Array<{ runId: string; sessionId: string; tenantId: string | null; turns: number }>;
  };
  approvals: {
    count: number;
    resolvedCount: number;
    waitP50Ms: number | null;
    waitP90Ms: number | null;
    byTool: Array<{ toolName: string; count: number; avgWaitMs: number | null }>;
  };
  waste: {
    duplicateToolCalls: {
      affectedRuns: number;
      totalDuplicateCalls: number;
      topOffenders: Array<{ toolName: string; duplicates: number }>;
    };
    repeatedFileReads: {
      affectedRuns: number;
      topFiles: Array<{ filePath: string; repeats: number; runId: string }>;
    };
    unmodifiedRetries: {
      count: number;
      byTool: Array<{ toolName: string; count: number }>;
    };
  };
}

export class RuntimeEfficiencyQuery {
  private readonly pool: EfficiencyQueryPool;
  private readonly eventsTable: string;
  private readonly runsTable: string;
  private readonly usageTable: string;

  constructor(options: RuntimeEfficiencyQueryOptions) {
    this.pool = options.pool;
    this.eventsTable = sanitizeQualifiedIdentifier(options.eventsTable);
    this.runsTable = sanitizeQualifiedIdentifier(options.runsTable);
    this.usageTable = sanitizeQualifiedIdentifier(options.billingUsageEventsTable);
  }

  async listRecentRuns(opts: RecentRunsQueryOptions): Promise<RecentRunSummary[]> {
    const statuses = opts.statuses && opts.statuses.length > 0 ? opts.statuses : null;
    const result = await this.pool.query(`/* eff:recent_runs */
      SELECT run_id, session_id, tenant_id, user_id, status, status_reason, model, channel,
             requested_at, started_at, completed_at, failed_at, cancelled_at
      FROM ${this.runsTable}
      WHERE updated_at >= now() - make_interval(hours => $1::int)
        AND ($2::text[] IS NULL OR status = ANY($2::text[]))
        AND ($3::text IS NULL OR tenant_id = $3)
      ORDER BY updated_at DESC
      LIMIT $4
    `, [opts.hours, statuses, opts.tenantId ?? null, opts.limit]);
    return result.rows.map((row) => normalizeRecentRunRow(row));
  }

  async getEfficiency(opts: EfficiencyQueryOptions): Promise<EfficiencyReport> {
    const to = new Date();
    const from = new Date(to.getTime() - opts.days * 24 * 60 * 60 * 1000);
    const params = [from.toISOString(), opts.tenantId ?? null];
    const E = this.eventsTable;
    const U = this.usageTable;
    const R = this.runsTable;

    // ── outcome：run_finished 按 subtype 分布 ──
    const outcomeRows = (await this.pool.query(`/* eff:outcome */
      SELECT event_json->>'subtype' AS subtype, COUNT(*)::bigint AS count
      FROM ${E}
      WHERE event_type = 'run_finished'
        AND timestamp >= $1::timestamptz
        AND ($2::text IS NULL OR tenant_id = $2)
      GROUP BY 1
    `, params)).rows;

    const errorReasonRows = (await this.pool.query(`/* eff:error_reasons */
      SELECT left(COALESCE(NULLIF(event_json->>'error', ''), '(no error message)'), 120) AS reason,
             COUNT(*)::bigint AS count,
             MAX(run_id) AS sample_run_id
      FROM ${E}
      WHERE event_type = 'run_finished'
        AND event_json->>'subtype' = 'error'
        AND timestamp >= $1::timestamptz
        AND ($2::text IS NULL OR tenant_id = $2)
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT 15
    `, params)).rows;

    // ── tools：tool_audit 按工具聚合 + hand_failure 计数 ──
    const toolRows = (await this.pool.query(`/* eff:tools */
      SELECT COALESCE(event_json->>'toolName', '(unknown)') AS tool_name,
             COUNT(*)::bigint AS calls,
             (COUNT(*) FILTER (WHERE event_json->>'status' = 'error'))::bigint AS errors,
             COALESCE(SUM(CASE WHEN jsonb_typeof(event_json->'durationMs') = 'number'
                               THEN (event_json->>'durationMs')::numeric ELSE 0 END), 0) AS total_duration_ms
      FROM ${E}
      WHERE event_type = 'tool_audit'
        AND timestamp >= $1::timestamptz
        AND ($2::text IS NULL OR tenant_id = $2)
      GROUP BY 1
      ORDER BY 2 DESC
    `, params)).rows;

    const handFailureRow = (await this.pool.query(`/* eff:hand_failures */
      SELECT COUNT(*)::bigint AS count
      FROM ${E}
      WHERE event_type = 'hand_failure'
        AND timestamp >= $1::timestamptz
        AND ($2::text IS NULL OR tenant_id = $2)
    `, params)).rows[0];

    // ── cost：billing usage 按模型聚合 / 每 run 成本分位 / 失败 run 总成本 ──
    const costByModelRows = (await this.pool.query(`/* eff:cost_by_model */
      SELECT COALESCE(actual_model, model_value) AS model,
             COUNT(*)::bigint AS requests,
             COALESCE(SUM(actual_cost_yuan_micro), 0)::bigint AS cost_micro,
             COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
             COALESCE(SUM(cached_input_tokens), 0)::bigint AS cached_input_tokens,
             COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
      FROM ${U}
      WHERE created_at >= $1::timestamptz
        AND ($2::text IS NULL OR tenant_id = $2)
      GROUP BY 1
      ORDER BY 3 DESC
    `, params)).rows;

    const perRunRow = (await this.pool.query(`/* eff:cost_per_run */
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY run_cost_micro) AS p50_micro,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY run_cost_micro) AS p90_micro,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY run_cost_micro) AS p99_micro
      FROM (
        SELECT SUM(actual_cost_yuan_micro)::float8 AS run_cost_micro
        FROM ${U}
        WHERE created_at >= $1::timestamptz
          AND run_id IS NOT NULL
          AND ($2::text IS NULL OR tenant_id = $2)
        GROUP BY run_id
      ) per_run
    `, params)).rows[0];

    const failedCostRow = (await this.pool.query(`/* eff:cost_failed_runs */
      SELECT COALESCE(SUM(u.actual_cost_yuan_micro), 0)::bigint AS cost_micro
      FROM ${U} u
      WHERE u.created_at >= $1::timestamptz
        AND ($2::text IS NULL OR u.tenant_id = $2)
        AND u.run_id IN (
          SELECT DISTINCT run_id FROM ${E}
          WHERE event_type = 'run_finished'
            AND event_json->>'subtype' = 'error'
            AND run_id IS NOT NULL
            AND timestamp >= $1::timestamptz
            AND ($2::text IS NULL OR tenant_id = $2)
        )
    `, params)).rows[0];

    // ── longTail：最慢 run（runs 表终态耗时）+ 最多轮次（run_finished.numTurns） ──
    const slowestRows = (await this.pool.query(`/* eff:slowest_runs */
      SELECT run_id, session_id, tenant_id, status, model,
             (EXTRACT(EPOCH FROM (COALESCE(completed_at, failed_at) - started_at)) * 1000)::bigint AS duration_ms
      FROM ${R}
      WHERE status IN ('completed', 'failed')
        AND started_at IS NOT NULL
        AND COALESCE(completed_at, failed_at) IS NOT NULL
        AND updated_at >= $1::timestamptz
        AND ($2::text IS NULL OR tenant_id = $2)
      ORDER BY 6 DESC
      LIMIT 10
    `, params)).rows;

    const mostTurnsRows = (await this.pool.query(`/* eff:most_turns */
      SELECT run_id, session_id, tenant_id,
             MAX((event_json->>'numTurns')::numeric) AS turns
      FROM ${E}
      WHERE event_type = 'run_finished'
        AND run_id IS NOT NULL
        AND jsonb_typeof(event_json->'numTurns') = 'number'
        AND timestamp >= $1::timestamptz
        AND ($2::text IS NULL OR tenant_id = $2)
      GROUP BY 1, 2, 3
      ORDER BY 4 DESC
      LIMIT 10
    `, params)).rows;

    // ── approvals：requested/resolved 按 approvalId join（同 session），等待时长分位 ──
    const approvalsSummaryRow = (await this.pool.query(`/* eff:approvals_summary */
      WITH req AS (
        SELECT session_id, event_json->>'approvalId' AS approval_id, timestamp
        FROM ${E}
        WHERE event_type = 'approval_requested'
          AND timestamp >= $1::timestamptz
          AND ($2::text IS NULL OR tenant_id = $2)
      ),
      res AS (
        SELECT session_id, event_json->>'approvalId' AS approval_id, MIN(timestamp) AS resolved_at
        FROM ${E}
        WHERE event_type = 'approval_resolved'
          AND timestamp >= $1::timestamptz
          AND ($2::text IS NULL OR tenant_id = $2)
        GROUP BY 1, 2
      ),
      joined AS (
        SELECT (EXTRACT(EPOCH FROM (res.resolved_at - req.timestamp)) * 1000)::float8 AS wait_ms
        FROM req
        LEFT JOIN res ON res.session_id = req.session_id AND res.approval_id = req.approval_id
      )
      SELECT COUNT(*)::bigint AS count,
             COUNT(wait_ms)::bigint AS resolved_count,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_ms) FILTER (WHERE wait_ms IS NOT NULL) AS wait_p50_ms,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY wait_ms) FILTER (WHERE wait_ms IS NOT NULL) AS wait_p90_ms
      FROM joined
    `, params)).rows[0];

    const approvalsByToolRows = (await this.pool.query(`/* eff:approvals_by_tool */
      WITH req AS (
        SELECT session_id, event_json->>'approvalId' AS approval_id,
               COALESCE(event_json->>'toolName', '(unknown)') AS tool_name, timestamp
        FROM ${E}
        WHERE event_type = 'approval_requested'
          AND timestamp >= $1::timestamptz
          AND ($2::text IS NULL OR tenant_id = $2)
      ),
      res AS (
        SELECT session_id, event_json->>'approvalId' AS approval_id, MIN(timestamp) AS resolved_at
        FROM ${E}
        WHERE event_type = 'approval_resolved'
          AND timestamp >= $1::timestamptz
          AND ($2::text IS NULL OR tenant_id = $2)
        GROUP BY 1, 2
      )
      SELECT req.tool_name,
             COUNT(*)::bigint AS count,
             AVG(EXTRACT(EPOCH FROM (res.resolved_at - req.timestamp)) * 1000) AS avg_wait_ms
      FROM req
      LEFT JOIN res ON res.session_id = req.session_id AND res.approval_id = req.approval_id
      GROUP BY 1
      ORDER BY 2 DESC
    `, params)).rows;

    // ── waste 1：同 run 同工具同参数 hash 的重复调用（duplicates = count-1 之和） ──
    const duplicatesRow = (await this.pool.query(`/* eff:waste_duplicates */
      WITH calls AS (
        SELECT e.run_id,
               COALESCE(call->>'name', '(unknown)') AS tool_name,
               md5(COALESCE(call->>'arguments', '')) AS args_hash
        FROM ${E} e,
             jsonb_array_elements(
               CASE WHEN jsonb_typeof(e.event_json->'toolCalls') = 'array'
                    THEN e.event_json->'toolCalls' ELSE '[]'::jsonb END
             ) AS call
        WHERE e.event_type = 'assistant_tool_calls'
          AND e.run_id IS NOT NULL
          AND e.timestamp >= $1::timestamptz
          AND ($2::text IS NULL OR e.tenant_id = $2)
      ),
      dup AS (
        SELECT run_id, tool_name, COUNT(*)::bigint - 1 AS duplicates
        FROM calls
        GROUP BY run_id, tool_name, args_hash
        HAVING COUNT(*) > 1
      )
      SELECT COUNT(DISTINCT run_id)::bigint AS affected_runs,
             COALESCE(SUM(duplicates), 0)::bigint AS total_duplicate_calls,
             COALESCE((
               SELECT json_agg(json_build_object('toolName', d.tool_name, 'duplicates', d.duplicates)
                               ORDER BY d.duplicates DESC)
               FROM (
                 SELECT tool_name, SUM(duplicates)::bigint AS duplicates
                 FROM dup GROUP BY 1 ORDER BY 2 DESC LIMIT 10
               ) d
             ), '[]'::json) AS top_offenders
      FROM dup
    `, params)).rows[0];

    // ── waste 2：Read 工具同 run 重复读同一文件。SQL 按 arguments hash 分组取样本，
    //    Node 侧解析 path（不同 offset/limit 的同文件读会分散在多个 hash 组，聚合后按 path 合并）。
    const readGroupRows = (await this.pool.query(`/* eff:waste_read_groups */
      SELECT e.run_id,
             MIN(left(call->>'arguments', 2000)) AS sample_arguments,
             COUNT(*)::bigint AS repeats
      FROM ${E} e,
           jsonb_array_elements(
             CASE WHEN jsonb_typeof(e.event_json->'toolCalls') = 'array'
                  THEN e.event_json->'toolCalls' ELSE '[]'::jsonb END
           ) AS call
      WHERE e.event_type = 'assistant_tool_calls'
        AND e.run_id IS NOT NULL
        AND call->>'name' = 'Read'
        AND e.timestamp >= $1::timestamptz
        AND ($2::text IS NULL OR e.tenant_id = $2)
      GROUP BY e.run_id, md5(COALESCE(call->>'arguments', ''))
      ORDER BY 3 DESC
      LIMIT 20000
    `, params)).rows;

    // ── waste 3：相邻两次同工具同参数、且前一次 tool_audit=error 的原样重试（lag 窗口） ──
    const retriesRow = (await this.pool.query(`/* eff:waste_retries */
      WITH calls AS (
        SELECT e.run_id, e.session_id, e.session_sequence, t.ord,
               t.call->>'id' AS tool_call_id,
               COALESCE(t.call->>'name', '(unknown)') AS tool_name,
               md5(COALESCE(t.call->>'arguments', '')) AS args_hash
        FROM ${E} e,
             jsonb_array_elements(
               CASE WHEN jsonb_typeof(e.event_json->'toolCalls') = 'array'
                    THEN e.event_json->'toolCalls' ELSE '[]'::jsonb END
             ) WITH ORDINALITY AS t(call, ord)
        WHERE e.event_type = 'assistant_tool_calls'
          AND e.run_id IS NOT NULL
          AND e.timestamp >= $1::timestamptz
          AND ($2::text IS NULL OR e.tenant_id = $2)
      ),
      seq AS (
        SELECT run_id, session_id, tool_name, args_hash,
               lag(tool_name) OVER w AS prev_tool_name,
               lag(args_hash) OVER w AS prev_args_hash,
               lag(tool_call_id) OVER w AS prev_tool_call_id
        FROM calls
        WINDOW w AS (PARTITION BY run_id ORDER BY session_sequence ASC, ord ASC)
      ),
      retries AS (
        SELECT s.run_id, s.tool_name
        FROM seq s
        WHERE s.prev_tool_name = s.tool_name
          AND s.prev_args_hash = s.args_hash
          AND EXISTS (
            SELECT 1 FROM ${E} a
            WHERE a.event_type = 'tool_audit'
              AND a.session_id = s.session_id
              AND a.event_json->>'toolCallId' = s.prev_tool_call_id
              AND a.event_json->>'status' = 'error'
          )
      )
      SELECT COUNT(*)::bigint AS count,
             COALESCE((
               SELECT json_agg(json_build_object('toolName', r.tool_name, 'count', r.count)
                               ORDER BY r.count DESC)
               FROM (SELECT tool_name, COUNT(*)::bigint AS count FROM retries GROUP BY 1) r
             ), '[]'::json) AS by_tool
      FROM retries
    `, params)).rows[0];

    return {
      range: { from: from.toISOString(), to: to.toISOString(), days: opts.days },
      tenantId: opts.tenantId ?? null,
      outcome: buildOutcomeSection(outcomeRows, errorReasonRows),
      tools: buildToolsSection(toolRows, handFailureRow),
      cost: buildCostSection(costByModelRows, perRunRow, failedCostRow),
      longTail: buildLongTailSection(slowestRows, mostTurnsRows),
      approvals: buildApprovalsSection(approvalsSummaryRow, approvalsByToolRows),
      waste: {
        duplicateToolCalls: buildDuplicateToolCallsSection(duplicatesRow),
        repeatedFileReads: buildRepeatedFileReadsSection(readGroupRows),
        unmodifiedRetries: buildUnmodifiedRetriesSection(retriesRow),
      },
    };
  }
}

// ────────────────────────── rows → response 纯转换（导出供单测） ──────────────────────────

type Row = Record<string, unknown> | undefined;

/** PG bigint/numeric 经驱动返回字符串；统一转 number，非法值归 0。 */
function toNum(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** 分位数等"无数据即 null"字段的转换。 */
function toNumOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = toNum(value);
  return Number.isFinite(n) ? n : null;
}

function toStrOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

/** 比率（防 0）：分母 <= 0 返回 null，保留 4 位小数。 */
function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

/** 微元 → 元，保留 6 位内精度。 */
export function microToYuan(micro: unknown): number {
  return Number((toNum(micro) / 1e6).toFixed(6));
}

/** runtime_runs 行 → RecentRunSummary（durationMs 按终态时间戳能算则算）。 */
export function normalizeRecentRunRow(row: Record<string, unknown>): RecentRunSummary {
  const status = String(row.status ?? '');
  const startedAt = toIsoOrNull(row.started_at);
  const completedAt = toIsoOrNull(row.completed_at);
  const failedAt = toIsoOrNull(row.failed_at);
  const cancelledAt = toIsoOrNull(row.cancelled_at);
  const terminalAt = status === 'completed' ? completedAt
    : status === 'failed' ? failedAt
    : status === 'cancelled' ? cancelledAt
    : null;
  const durationMs = startedAt && terminalAt
    ? Date.parse(terminalAt) - Date.parse(startedAt)
    : undefined;
  return {
    runId: String(row.run_id ?? ''),
    sessionId: String(row.session_id ?? ''),
    tenantId: toStrOrNull(row.tenant_id),
    userId: toStrOrNull(row.user_id),
    status,
    statusReason: toStrOrNull(row.status_reason),
    model: toStrOrNull(row.model),
    channel: toStrOrNull(row.channel),
    requestedAt: toIsoOrNull(row.requested_at),
    startedAt,
    completedAt,
    failedAt,
    cancelledAt,
    ...(durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
  };
}

export function buildOutcomeSection(
  subtypeRows: Array<Record<string, unknown>>,
  errorReasonRows: Array<Record<string, unknown>>,
): EfficiencyReport['outcome'] {
  let totalRuns = 0;
  let success = 0;
  let error = 0;
  let interrupted = 0;
  for (const row of subtypeRows) {
    const count = toNum(row.count);
    totalRuns += count;
    if (row.subtype === 'success') success += count;
    else if (row.subtype === 'error') error += count;
    else if (row.subtype === 'interrupted') interrupted += count;
  }
  return {
    totalRuns,
    success,
    error,
    interrupted,
    completionRate: ratio(success, totalRuns),
    errorReasons: errorReasonRows.map((row) => ({
      reason: String(row.reason ?? ''),
      count: toNum(row.count),
      sampleRunId: toStrOrNull(row.sample_run_id),
    })),
  };
}

export function buildToolsSection(
  toolRows: Array<Record<string, unknown>>,
  handFailureRow: Row,
): EfficiencyReport['tools'] {
  return {
    byTool: toolRows.map((row) => {
      const calls = toNum(row.calls);
      const errors = toNum(row.errors);
      const totalDurationMs = Math.round(toNum(row.total_duration_ms));
      return {
        toolName: String(row.tool_name ?? '(unknown)'),
        calls,
        errors,
        errorRate: ratio(errors, calls),
        totalDurationMs,
        avgDurationMs: calls > 0 ? Math.round(totalDurationMs / calls) : null,
      };
    }),
    handFailures: toNum(handFailureRow?.count),
  };
}

export function buildCostSection(
  byModelRows: Array<Record<string, unknown>>,
  perRunRow: Row,
  failedCostRow: Row,
): EfficiencyReport['cost'] {
  let totalMicro = 0;
  let totalInput = 0;
  let totalCached = 0;
  const byModel = byModelRows.map((row) => {
    const costMicro = toNum(row.cost_micro);
    const inputTokens = toNum(row.input_tokens);
    const cachedInputTokens = toNum(row.cached_input_tokens);
    totalMicro += costMicro;
    totalInput += inputTokens;
    totalCached += cachedInputTokens;
    return {
      model: String(row.model ?? '(unknown)'),
      costYuan: microToYuan(costMicro),
      requests: toNum(row.requests),
      inputTokens,
      cachedInputTokens,
      outputTokens: toNum(row.output_tokens),
      cacheHitRate: ratio(cachedInputTokens, inputTokens),
    };
  });
  const p50 = toNumOrNull(perRunRow?.p50_micro);
  const p90 = toNumOrNull(perRunRow?.p90_micro);
  const p99 = toNumOrNull(perRunRow?.p99_micro);
  return {
    totalCostYuan: microToYuan(totalMicro),
    byModel,
    perRun: {
      p50: p50 === null ? null : microToYuan(p50),
      p90: p90 === null ? null : microToYuan(p90),
      p99: p99 === null ? null : microToYuan(p99),
    },
    failedRunsCostYuan: microToYuan(failedCostRow?.cost_micro),
    cacheHitRate: ratio(totalCached, totalInput),
  };
}

export function buildLongTailSection(
  slowestRows: Array<Record<string, unknown>>,
  mostTurnsRows: Array<Record<string, unknown>>,
): EfficiencyReport['longTail'] {
  return {
    slowestRuns: slowestRows.map((row) => ({
      runId: String(row.run_id ?? ''),
      sessionId: String(row.session_id ?? ''),
      tenantId: toStrOrNull(row.tenant_id),
      durationMs: Math.round(toNum(row.duration_ms)),
      status: String(row.status ?? ''),
      model: toStrOrNull(row.model),
    })),
    mostTurns: mostTurnsRows.map((row) => ({
      runId: String(row.run_id ?? ''),
      sessionId: String(row.session_id ?? ''),
      tenantId: toStrOrNull(row.tenant_id),
      turns: Math.round(toNum(row.turns)),
    })),
  };
}

export function buildApprovalsSection(
  summaryRow: Row,
  byToolRows: Array<Record<string, unknown>>,
): EfficiencyReport['approvals'] {
  const p50 = toNumOrNull(summaryRow?.wait_p50_ms);
  const p90 = toNumOrNull(summaryRow?.wait_p90_ms);
  return {
    count: toNum(summaryRow?.count),
    resolvedCount: toNum(summaryRow?.resolved_count),
    waitP50Ms: p50 === null ? null : Math.round(p50),
    waitP90Ms: p90 === null ? null : Math.round(p90),
    byTool: byToolRows.map((row) => {
      const avg = toNumOrNull(row.avg_wait_ms);
      return {
        toolName: String(row.tool_name ?? '(unknown)'),
        count: toNum(row.count),
        avgWaitMs: avg === null ? null : Math.round(avg),
      };
    }),
  };
}

export function buildDuplicateToolCallsSection(
  row: Row,
): EfficiencyReport['waste']['duplicateToolCalls'] {
  const rawTop = Array.isArray(row?.top_offenders) ? row.top_offenders : [];
  return {
    affectedRuns: toNum(row?.affected_runs),
    totalDuplicateCalls: toNum(row?.total_duplicate_calls),
    topOffenders: rawTop.map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return {
        toolName: String(record.toolName ?? '(unknown)'),
        duplicates: toNum(record.duplicates),
      };
    }),
  };
}

/**
 * Read 工具参数 JSON → 文件路径。兼容 path / file_path 两种参数名
 * （与 toolRuntime 的输入取参逻辑一致），非法 JSON / 缺路径返回 undefined。
 */
export function parseReadToolFilePath(argsJson: string | null | undefined): string | undefined {
  if (!argsJson) return undefined;
  try {
    const parsed = JSON.parse(argsJson) as { path?: unknown; file_path?: unknown } | null;
    const path = parsed?.path ?? parsed?.file_path;
    return typeof path === 'string' && path.length > 0 ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * (run_id, arguments hash) 分组行 → 按 (run, 文件路径) 合并（同文件不同 offset/limit
 * 会分散在多个 hash 组），过滤同 run 同文件 >= 3 次，取 top 10。
 */
export function buildRepeatedFileReadsSection(
  rows: Array<Record<string, unknown>>,
): EfficiencyReport['waste']['repeatedFileReads'] {
  const byRunAndFile = new Map<string, { runId: string; filePath: string; repeats: number }>();
  for (const row of rows) {
    const runId = toStrOrNull(row.run_id);
    if (!runId) continue;
    const filePath = parseReadToolFilePath(typeof row.sample_arguments === 'string' ? row.sample_arguments : undefined);
    if (!filePath) continue;
    const key = `${runId} ${filePath}`;
    const existing = byRunAndFile.get(key);
    if (existing) existing.repeats += toNum(row.repeats);
    else byRunAndFile.set(key, { runId, filePath, repeats: toNum(row.repeats) });
  }
  const repeated = [...byRunAndFile.values()].filter((entry) => entry.repeats >= 3);
  const affectedRuns = new Set(repeated.map((entry) => entry.runId)).size;
  const topFiles = repeated
    .sort((a, b) => b.repeats - a.repeats)
    .slice(0, 10)
    .map((entry) => ({ filePath: entry.filePath, repeats: entry.repeats, runId: entry.runId }));
  return { affectedRuns, topFiles };
}

export function buildUnmodifiedRetriesSection(
  row: Row,
): EfficiencyReport['waste']['unmodifiedRetries'] {
  const rawByTool = Array.isArray(row?.by_tool) ? row.by_tool : [];
  return {
    count: toNum(row?.count),
    byTool: rawByTool.map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return {
        toolName: String(record.toolName ?? '(unknown)'),
        count: toNum(record.count),
      };
    }),
  };
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`非法 PG identifier: ${value}`);
  }
  return value;
}

function sanitizeQualifiedIdentifier(value: string): string {
  return value.split('.').map(sanitizeIdentifier).join('.');
}
