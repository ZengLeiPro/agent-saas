/**
 * Token Usage Store — 每用户每日每模型每通道的 token 用量
 *
 * 数据模型：
 *   一行 = (date 北京时间 YYYY-MM-DD, username, model, channel) 的累计
 *   精确时间筛选另有 token_usage_minutely：
 *     一行 = (minute 北京时间 YYYY-MM-DDTHH:mm, username, model, channel) 的累计
 *   一次 runtime result 触发一次 recordResult()，按 modelUsage 拆出多个 model 各执行一次 UPSERT
 *
 * 写入幂等性：
 *   - 实时路径（runtime Result）：每次 run/resume 只触发一次 Result，自然幂等
 *   - 回填路径（rebuildFromJsonl）：先 DELETE 再 INSERT，独立处理，不走 recordResult
 *
 * 时区：
 *   - 业务统一按北京时间（UTC+8）切日
 *   - 存储的 date 字段为 'YYYY-MM-DD' 形式的北京日期
 */

import type { DatabaseSync } from 'node:sqlite';

import {
  PRICING_VERSION,
  computeCacheHitDenominatorTokens,
  computeCostMicro,
  computeUsageTotalTokens,
} from './pricing.js';
import { LEGACY_TENANT_ID } from '../tenants/types.js';

/**
 * runner 上报的 ModelUsage 按模型拆分后的 usage 字段。
 * 此处只列我们用到的字段，不依赖 SDK 类型避免循环 import。
 *
 * 注意：`costUSD` 字段我们**不再使用**——cost 由本地 pricing.ts 统一计算，
 * 原因见 pricing.ts 顶部注释（OAuth 统计 vs 真实账单、GPT 转发偏差、回填路径无此字段）。
 * 保留字段定义只是为了不破坏 SDK 类型兼容性。
 */
export interface SdkModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  apiRequestCount?: number;
  costUSD?: number;
  webSearchRequests?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface RecordResultParams {
  /** 业务用户名（从闭包/AsyncLocalStorage 取） */
  username: string;
  /** 业务组织 slug（必填；PR 10 跨组织隔离）。username 全局唯一，但 token usage 表显式按 tenantId 切片，便于 admin 跨组织分析。 */
  tenantId: string;
  /** 通道/来源：主对话、cron、钉钉、子 agent（独立归因，D7），以及基础设施类 LLM 调用 */
  channel: 'web' | 'cron' | 'dingtalk' | 'subagent' | 'title' | 'embedding' | 'guardrail';
  /** SDK 的 modelUsage 对象（key 是 model id 原样字符串，如 'claude-opus-4-7[1m]'） */
  modelUsage: Record<string, SdkModelUsage>;
  /** 事件发生时刻（ms epoch） */
  occurredAtMs: number;
}

export interface UsageDailyRow {
  date: string;
  username: string;
  /** 组织 slug（PR 10）。读侧 SQL 加 (tenant_id = ?) 过滤；列表/聚合返回时保留供 admin UI 标注。 */
  tenantId: string;
  model: string;
  channel: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsdMicro: number;
  turnCount: number;
  firstSeenAtMs: number;
  updatedAtMs: number;
}

/**
 * 模型家族筛选：
 *   - 'claude' = model LIKE 'claude%'
 *   - 'gpt'    = model LIKE 'gpt%'
 *   - 'other'  = 既不属于 claude 也不属于 gpt（doubao / glm / MiniMax 等）
 *   - undefined = 全部模型
 *
 * 判定基于 model 字段前缀，SQLite LIKE 对 ASCII 大小写不敏感。
 */
export type ModelFamily = 'claude' | 'gpt' | 'other';

export interface TokenUsageStore {
  /** SDK Result 到达时调用一次（按 model 拆 UPSERT） */
  recordResult: (params: RecordResultParams) => void;

  /** 回填用：直接累加一行（不递增 turn_count，由 caller 显式给 turnDelta） */
  upsertRaw: (row: UsageDailyRowDelta) => void;

  /** 全清（仅回填路径使用，调用前要确保 caller 知道自己在做什么） */
  clearAll: () => void;

  /** 删某天某用户的全部行（回填路径分批清理用） */
  deleteUserDate: (username: string, date: string) => number;

  /** 删除某组织的全部 SQLite token usage 行（组织删除路径使用）。 */
  deleteTenant: (tenantId: string) => number;

  /** 读：指定日期所有行 */
  listByDate: (date: string) => UsageDailyRow[];

  /** 读：指定用户日期区间 */
  listByUsername: (username: string, fromDate?: string, toDate?: string) => UsageDailyRow[];

  /** 读：rebuild 状态 */
  getRebuildState: () => RebuildState | null;

  /** 写：rebuild 状态 */
  setRebuildState: (state: Omit<RebuildState, 'id'>) => void;

  // ────────── 聚合查询（供 admin API 使用） ──────────
  //
  // 所有聚合方法的 tenantId 参数语义（PR 10）：
  //   - undefined → 跨组织合计（仅平台 admin 用，路由层把 caller.isPlatformAdmin 转译成 undefined）
  //   - 具体 slug → 仅该组织的数据；组织 admin 路由层强制传 caller.tenantId
  //
  // SQL 用 (? IS NULL OR tenant_id = ?) 形式实现统一过滤，避免分两条 SQL。

  /** 全公司期间总览：合计 4 类 token / cost / turns / 活跃用户数 */
  getOverview: (fromDate: string, toDate: string, family?: ModelFamily, tenantId?: string) => OverviewStats;

  /** 按用户聚合：期间各用户的总量与缓存命中率 */
  getByUser: (fromDate: string, toDate: string, family?: ModelFamily, tenantId?: string) => UserAggregate[];

  /** 按模型聚合（可选 username 过滤；可选 family 过滤） */
  getByModel: (
    fromDate: string,
    toDate: string,
    username?: string,
    family?: ModelFamily,
    tenantId?: string,
  ) => ModelAggregate[];

  /** 单用户日趋势（每天一行，含全部 token 类别） */
  getTrend: (
    username: string,
    fromDate: string,
    toDate: string,
    family?: ModelFamily,
    tenantId?: string,
  ) => DailyTrendRow[];

  /** 全公司日趋势（跨所有用户按日期聚合） */
  getTrendAll: (fromDate: string, toDate: string, family?: ModelFamily, tenantId?: string) => DailyTrendRow[];

  /** 按通道聚合（web / cron），可选 username 过滤；可选 family 过滤 */
  getByChannel: (
    fromDate: string,
    toDate: string,
    username?: string,
    family?: ModelFamily,
    tenantId?: string,
  ) => ChannelAggregate[];

  /** 数据完整性元信息：最早/最晚日期、首条带 cost 的日期 */
  getDataRange: (tenantId?: string) => DataRange;
}

// ────────── 聚合结果类型 ──────────

export interface OverviewStats {
  fromDate: string;
  toDate: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  totalTurns: number;
  activeUsers: number;
  /** 缓存命中率：OpenAI-compatible 为 cacheRead/input；Anthropic 原生为 cacheRead/(input+cacheRead+cacheCreation) */
  cacheHitRatio: number | null;
}

export interface UserAggregate {
  username: string;
  /** 该用户所属组织 slug（PR 10，由 SQL `GROUP BY username, tenant_id` 返回） */
  tenantId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  totalTurns: number;
  cacheHitRatio: number | null;
  lastActiveDate: string;
}

export interface ChannelAggregate {
  channel: string;
  totalTokens: number;
  totalCostUsd: number;
  totalTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ModelAggregate {
  model: string;
  totalTokens: number;
  totalCostUsd: number;
  totalTurns: number;
  // 各分量（便于前端做堆叠柱）
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface DailyTrendRow {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  turns: number;
}

export interface DataRange {
  earliestDate: string | null;
  latestDate: string | null;
  /** 首个带 cost 数据的日期。回填路径 cost=0，实时路径才有真实 cost，这个值标识"cost 维度从哪天起可信" */
  firstCostDate: string | null;
}

export interface UsageDailyRowDelta {
  date: string;
  username: string;
  /** 组织 slug（PR 10，回填路径从 jsonl 路径 parts[0] 解析；旧布局兜底 LEGACY_TENANT_ID） */
  tenantId: string;
  model: string;
  channel: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsdMicro: number;
  turnDelta: number;
  occurredAtMs: number;
}

export interface RebuildState {
  lastRebuildAtMs: number;
  lastFullScanMs: number | null;
  jsonlMaxMtimeMs: number;
  totalFilesScanned: number;
  totalRowsBuilt: number;
}

/**
 * 把毫秒 epoch 转成北京日期 'YYYY-MM-DD'。
 * SQLite 本身按 UTC 处理，业务层统一在 store 入口转换，避免下游每个查询都做时区运算。
 */
export function formatBeijingDate(ms: number): string {
  const shifted = new Date(ms + 8 * 3600 * 1000);
  // toISOString 返回 UTC 视角 ISO 字符串。我们已经偏移 +8，所以 UTC 视角即北京视角
  return shifted.toISOString().slice(0, 10);
}

export function formatBeijingMinute(ms: number): string {
  const shifted = new Date(ms + 8 * 3600 * 1000);
  return shifted.toISOString().slice(0, 16);
}

const BEIJING_MINUTE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function isMinuteRange(from: string, to: string): boolean {
  return BEIJING_MINUTE_RE.test(from) || BEIJING_MINUTE_RE.test(to);
}

/**
 * 把 ModelFamily 转换成 SQL `AND ...` 片段。
 * family 取值为枚举常量（非用户自由文本），可直接拼接，无 SQL 注入风险。
 */
function familyClause(family?: ModelFamily): string {
  if (!family) return '';
  if (family === 'claude') return ` AND model LIKE 'claude%'`;
  if (family === 'gpt') return ` AND model LIKE 'gpt%'`;
  // other
  return ` AND model NOT LIKE 'claude%' AND model NOT LIKE 'gpt%'`;
}

/**
 * tenantId 过滤 SQL 片段（PR 10）。
 * 调用方传一个 SQL 参数数组，本函数同时返回 SQL 片段与要 push 的参数。
 *   - tenantId === undefined → 不过滤（platform admin 跨组织）
 *   - tenantId !== undefined → ` AND tenant_id = ?` + push(tenantId)
 *
 * 注意：返回 SQL 片段已带前导空格 + AND；插入位置应是已有 WHERE 子句之后。
 */
function tenantClause(tenantId: string | undefined, params: Array<string | number | null>): string {
  if (tenantId === undefined) return '';
  params.push(tenantId);
  return ' AND tenant_id = ?';
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsdMicro: number;
  turns: number;
  cacheHitDenominatorTokens: number;
}

function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsdMicro: 0,
    turns: 0,
    cacheHitDenominatorTokens: 0,
  };
}

function addUsageTotals(target: UsageTotals, model: string, row: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsdMicro: number;
  turns: number;
}): UsageTotals {
  const tokens = {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheCreationTokens,
  };
  target.inputTokens += row.inputTokens;
  target.outputTokens += row.outputTokens;
  target.cacheReadTokens += row.cacheReadTokens;
  target.cacheCreationTokens += row.cacheCreationTokens;
  target.totalTokens += computeUsageTotalTokens(model, tokens);
  target.cacheHitDenominatorTokens += computeCacheHitDenominatorTokens(model, tokens);
  target.costUsdMicro += row.costUsdMicro;
  target.turns += row.turns;
  return target;
}

function aggregateSqlRow(r: Record<string, unknown>): {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsdMicro: number;
  turns: number;
} {
  return {
    model: r.model as string,
    inputTokens: Number(r.in_tok ?? 0),
    outputTokens: Number(r.out_tok ?? 0),
    cacheReadTokens: Number(r.cr_tok ?? 0),
    cacheCreationTokens: Number(r.cc_tok ?? 0),
    costUsdMicro: Number(r.cost_micro ?? 0),
    turns: Number(r.turns ?? 0),
  };
}

function cacheHitRatio(total: UsageTotals): number | null {
  return total.cacheHitDenominatorTokens > 0
    ? total.cacheReadTokens / total.cacheHitDenominatorTokens
    : null;
}

function rangeSource(from: string, to: string): {
  table: 'token_usage_daily' | 'token_usage_minutely';
  column: 'date' | 'minute';
  from: string;
  to: string;
} {
  if (isMinuteRange(from, to)) {
    return {
      table: 'token_usage_minutely',
      column: 'minute',
      from: from.includes('T') ? from : `${from}T00:00`,
      to: to.includes('T') ? to : `${to}T23:59`,
    };
  }
  return { table: 'token_usage_daily', column: 'date', from, to };
}

export function createTokenUsageStore(db: DatabaseSync): TokenUsageStore {
  // 写 SQL 增加 tenant_id 列（PR 10）。username 全局唯一，PRIMARY KEY 不含 tenant_id，
  // ON CONFLICT 不需要把 tenant_id 列进冲突目标——同 (date, username, model, channel) 行
  // 在物理上只可能属于一个 tenant，DO UPDATE 时 tenant_id 自然保持。
  // 但 INSERT 路径仍要把 tenant_id 列出来，避免依赖 legacy 默认值兜底而漏掉新组织数据。
  const upsertStmt = db.prepare(`
    INSERT INTO token_usage_daily
      (date, username, tenant_id, model, channel,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd_micro, turn_count, first_seen_at_ms, updated_at_ms, pricing_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, username, model, channel) DO UPDATE SET
      input_tokens          = input_tokens          + excluded.input_tokens,
      output_tokens         = output_tokens         + excluded.output_tokens,
      cache_read_tokens     = cache_read_tokens     + excluded.cache_read_tokens,
      cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
      cost_usd_micro        = cost_usd_micro        + excluded.cost_usd_micro,
      turn_count            = turn_count            + excluded.turn_count,
      updated_at_ms         = excluded.updated_at_ms,
      pricing_version       = excluded.pricing_version
  `);

  const upsertMinuteStmt = db.prepare(`
    INSERT INTO token_usage_minutely
      (minute, date, username, tenant_id, model, channel,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd_micro, turn_count, first_seen_at_ms, updated_at_ms, pricing_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(minute, username, model, channel) DO UPDATE SET
      input_tokens          = input_tokens          + excluded.input_tokens,
      output_tokens         = output_tokens         + excluded.output_tokens,
      cache_read_tokens     = cache_read_tokens     + excluded.cache_read_tokens,
      cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
      cost_usd_micro        = cost_usd_micro        + excluded.cost_usd_micro,
      turn_count            = turn_count            + excluded.turn_count,
      updated_at_ms         = excluded.updated_at_ms,
      pricing_version       = excluded.pricing_version
  `);

  const deleteUserDateStmt = db.prepare(
    `DELETE FROM token_usage_daily WHERE username = ? AND date = ?`,
  );
  const deleteUserDateMinuteStmt = db.prepare(
    `DELETE FROM token_usage_minutely WHERE username = ? AND date = ?`,
  );
  const deleteTenantDailyStmt = db.prepare(
    `DELETE FROM token_usage_daily WHERE tenant_id = ?`,
  );
  const deleteTenantMinuteStmt = db.prepare(
    `DELETE FROM token_usage_minutely WHERE tenant_id = ?`,
  );

  const listByDateStmt = db.prepare(`SELECT * FROM token_usage_daily WHERE date = ?`);
  const listByUserStmt = db.prepare(
    `SELECT * FROM token_usage_daily
     WHERE username = ?
       AND (? IS NULL OR date >= ?)
       AND (? IS NULL OR date <= ?)
     ORDER BY date DESC`,
  );

  function rowToTyped(r: Record<string, unknown>): UsageDailyRow {
    return {
      date: r.date as string,
      username: r.username as string,
      tenantId: (r.tenant_id as string | null) ?? LEGACY_TENANT_ID,
      model: r.model as string,
      channel: r.channel as string,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      cacheReadTokens: r.cache_read_tokens as number,
      cacheCreationTokens: r.cache_creation_tokens as number,
      costUsdMicro: r.cost_usd_micro as number,
      turnCount: r.turn_count as number,
      firstSeenAtMs: r.first_seen_at_ms as number,
      updatedAtMs: r.updated_at_ms as number,
    };
  }

  return {
    recordResult(params: RecordResultParams): void {
      const date = formatBeijingDate(params.occurredAtMs);
      const minute = formatBeijingMinute(params.occurredAtMs);
      const ts = Date.now();

      const entries = Object.entries(params.modelUsage);
      if (entries.length === 0) return;

      for (const [model, u] of entries) {
        if (!model) continue;
        const inputTokens = Math.max(0, Math.floor(u.inputTokens ?? 0));
        const outputTokens = Math.max(0, Math.floor(u.outputTokens ?? 0));
        const cacheReadTokens = Math.max(0, Math.floor(u.cacheReadInputTokens ?? 0));
        const cacheCreationTokens = Math.max(0, Math.floor(u.cacheCreationInputTokens ?? 0));
        const requestCount = Math.max(1, Math.floor(u.apiRequestCount ?? 1));
        const costUsdMicro = computeCostMicro(model, {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        });
        upsertStmt.run(
          date,
          params.username,
          params.tenantId,
          model,
          params.channel,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          costUsdMicro,
          requestCount,
          ts,
          ts,
          PRICING_VERSION,
        );
        upsertMinuteStmt.run(
          minute,
          date,
          params.username,
          params.tenantId,
          model,
          params.channel,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          costUsdMicro,
          requestCount,
          ts,
          ts,
          PRICING_VERSION,
        );
      }
    },

    upsertRaw(row: UsageDailyRowDelta): void {
      const occurredMinute = formatBeijingMinute(row.occurredAtMs);
      const minute = occurredMinute.slice(0, 10) === row.date ? occurredMinute : `${row.date}T00:00`;
      upsertStmt.run(
        row.date,
        row.username,
        row.tenantId,
        row.model,
        row.channel,
        Math.max(0, Math.floor(row.inputTokens)),
        Math.max(0, Math.floor(row.outputTokens)),
        Math.max(0, Math.floor(row.cacheReadTokens)),
        Math.max(0, Math.floor(row.cacheCreationTokens)),
        Math.max(0, Math.floor(row.costUsdMicro)),
        Math.max(0, Math.floor(row.turnDelta)),
        row.occurredAtMs,
        row.occurredAtMs,
        PRICING_VERSION,
      );
      upsertMinuteStmt.run(
        minute,
        row.date,
        row.username,
        row.tenantId,
        row.model,
        row.channel,
        Math.max(0, Math.floor(row.inputTokens)),
        Math.max(0, Math.floor(row.outputTokens)),
        Math.max(0, Math.floor(row.cacheReadTokens)),
        Math.max(0, Math.floor(row.cacheCreationTokens)),
        Math.max(0, Math.floor(row.costUsdMicro)),
        Math.max(0, Math.floor(row.turnDelta)),
        row.occurredAtMs,
        row.occurredAtMs,
        PRICING_VERSION,
      );
    },

    clearAll(): void {
      db.exec('DELETE FROM token_usage_daily');
      db.exec('DELETE FROM token_usage_minutely');
    },

    deleteUserDate(username: string, date: string): number {
      const r = deleteUserDateStmt.run(username, date);
      const mr = deleteUserDateMinuteStmt.run(username, date);
      return Number(r.changes ?? 0) + Number(mr.changes ?? 0);
    },

    deleteTenant(tenantId: string): number {
      const r = deleteTenantDailyStmt.run(tenantId);
      const mr = deleteTenantMinuteStmt.run(tenantId);
      return Number(r.changes ?? 0) + Number(mr.changes ?? 0);
    },

    listByDate(date: string): UsageDailyRow[] {
      const rows = listByDateStmt.all(date) as Record<string, unknown>[];
      return rows.map(rowToTyped);
    },

    listByUsername(username: string, fromDate?: string, toDate?: string): UsageDailyRow[] {
      const rows = listByUserStmt.all(
        username,
        fromDate ?? null,
        fromDate ?? null,
        toDate ?? null,
        toDate ?? null,
      ) as Record<string, unknown>[];
      return rows.map(rowToTyped);
    },

    getRebuildState(): RebuildState | null {
      const row = db
        .prepare('SELECT * FROM token_usage_rebuild_state WHERE id = 1')
        .get() as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        lastRebuildAtMs: row.last_rebuild_at_ms as number,
        lastFullScanMs: (row.last_full_scan_ms as number | null) ?? null,
        jsonlMaxMtimeMs: row.jsonl_max_mtime_ms as number,
        totalFilesScanned: row.total_files_scanned as number,
        totalRowsBuilt: row.total_rows_built as number,
      };
    },

    setRebuildState(state: Omit<RebuildState, 'id'>): void {
      db.prepare(`
        INSERT INTO token_usage_rebuild_state
          (id, last_rebuild_at_ms, last_full_scan_ms, jsonl_max_mtime_ms,
           total_files_scanned, total_rows_built)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          last_rebuild_at_ms  = excluded.last_rebuild_at_ms,
          last_full_scan_ms   = excluded.last_full_scan_ms,
          jsonl_max_mtime_ms  = excluded.jsonl_max_mtime_ms,
          total_files_scanned = excluded.total_files_scanned,
          total_rows_built    = excluded.total_rows_built
      `).run(
        state.lastRebuildAtMs,
        state.lastFullScanMs,
        state.jsonlMaxMtimeMs,
        state.totalFilesScanned,
        state.totalRowsBuilt,
      );
    },

    getOverview(fromDate: string, toDate: string, family?: ModelFamily, tenantId?: string): OverviewStats {
      const src = rangeSource(fromDate, toDate);
      const params: Array<string | number | null> = [src.from, src.to];
      const tClause = tenantClause(tenantId, params);
      const rows = db.prepare(`
        SELECT
          model,
          COALESCE(SUM(input_tokens), 0)          AS in_tok,
          COALESCE(SUM(output_tokens), 0)         AS out_tok,
          COALESCE(SUM(cache_read_tokens), 0)     AS cr_tok,
          COALESCE(SUM(cache_creation_tokens), 0) AS cc_tok,
          COALESCE(SUM(cost_usd_micro), 0)        AS cost_micro,
          COALESCE(SUM(turn_count), 0)            AS turns
        FROM ${src.table}
        WHERE ${src.column} >= ? AND ${src.column} <= ?${familyClause(family)}${tClause}
        GROUP BY model
      `).all(...params) as Record<string, unknown>[];
      const active = db.prepare(`
        SELECT COUNT(DISTINCT username) AS active_users
        FROM ${src.table}
        WHERE ${src.column} >= ? AND ${src.column} <= ?${familyClause(family)}${tClause}
      `).get(...params) as Record<string, number>;
      const totals = rows
        .map(aggregateSqlRow)
        .reduce((acc, row) => addUsageTotals(acc, row.model, row), emptyUsageTotals());

      return {
        fromDate,
        toDate,
        totalInputTokens: totals.inputTokens,
        totalOutputTokens: totals.outputTokens,
        totalCacheReadTokens: totals.cacheReadTokens,
        totalCacheCreationTokens: totals.cacheCreationTokens,
        totalTokens: totals.totalTokens,
        totalCostUsd: totals.costUsdMicro / 1e6,
        totalTurns: totals.turns,
        activeUsers: Number(active.active_users ?? 0),
        cacheHitRatio: cacheHitRatio(totals),
      };
    },

    getByUser(fromDate: string, toDate: string, family?: ModelFamily, tenantId?: string): UserAggregate[] {
      const src = rangeSource(fromDate, toDate);
      const params: Array<string | number | null> = [src.from, src.to];
      const tClause = tenantClause(tenantId, params);
      const rows = db.prepare(`
        SELECT
          username,
          tenant_id,
          model,
          SUM(input_tokens)          AS in_tok,
          SUM(output_tokens)         AS out_tok,
          SUM(cache_read_tokens)     AS cr_tok,
          SUM(cache_creation_tokens) AS cc_tok,
          SUM(cost_usd_micro)        AS cost_micro,
          SUM(turn_count)            AS turns,
          MAX(${src.column})         AS last_date
        FROM ${src.table}
        WHERE ${src.column} >= ? AND ${src.column} <= ?${familyClause(family)}${tClause}
        GROUP BY username, tenant_id, model
      `).all(...params) as Record<string, unknown>[];

      const byUser = new Map<string, UserAggregate & { _denominator: number }>();
      for (const r of rows) {
        const model = r.model as string;
        const row = aggregateSqlRow(r);
        const key = `${r.username as string}\0${(r.tenant_id as string | null) ?? LEGACY_TENANT_ID}`;
        const current = byUser.get(key) ?? {
          username: r.username as string,
          tenantId: (r.tenant_id as string | null) ?? LEGACY_TENANT_ID,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          totalTokens: 0,
          totalCostUsd: 0,
          totalTurns: 0,
          cacheHitRatio: null,
          lastActiveDate: r.last_date as string,
          _denominator: 0,
        };
        const tokens = {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheCreationTokens: row.cacheCreationTokens,
        };
        current.totalInputTokens += row.inputTokens;
        current.totalOutputTokens += row.outputTokens;
        current.totalCacheReadTokens += row.cacheReadTokens;
        current.totalCacheCreationTokens += row.cacheCreationTokens;
        current.totalTokens += computeUsageTotalTokens(model, tokens);
        current.totalCostUsd += row.costUsdMicro / 1e6;
        current.totalTurns += row.turns;
        current._denominator += computeCacheHitDenominatorTokens(model, tokens);
        if ((r.last_date as string) > current.lastActiveDate) current.lastActiveDate = r.last_date as string;
        byUser.set(key, current);
      }

      return Array.from(byUser.values())
        .map(({ _denominator, ...u }) => ({
          ...u,
          cacheHitRatio: _denominator > 0 ? u.totalCacheReadTokens / _denominator : null,
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens);
    },

    getByModel(
      fromDate: string,
      toDate: string,
      username?: string,
      family?: ModelFamily,
      tenantId?: string,
    ): ModelAggregate[] {
      const src = rangeSource(fromDate, toDate);
      const famSql = familyClause(family);
      const params: Array<string | number | null> = [src.from, src.to];
      if (username) params.push(username);
      const userClause = username ? ' AND username = ?' : '';
      const tClause = tenantClause(tenantId, params);
      const sql = `SELECT model,
             SUM(input_tokens)          AS in_tok,
             SUM(output_tokens)         AS out_tok,
             SUM(cache_read_tokens)     AS cr_tok,
             SUM(cache_creation_tokens) AS cc_tok,
             SUM(cost_usd_micro)        AS cost_micro,
             SUM(turn_count)            AS turns
           FROM ${src.table}
           WHERE ${src.column} >= ? AND ${src.column} <= ?${userClause}${famSql}${tClause}
           GROUP BY model
           ORDER BY (SUM(input_tokens) + SUM(output_tokens)
                    + SUM(cache_read_tokens) + SUM(cache_creation_tokens)) DESC`;
      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

      return rows.map((r) => {
        const row = aggregateSqlRow(r);
        const tokens = {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheCreationTokens: row.cacheCreationTokens,
        };
        return {
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheCreationTokens: row.cacheCreationTokens,
          totalTokens: computeUsageTotalTokens(row.model, tokens),
          totalCostUsd: row.costUsdMicro / 1e6,
          totalTurns: row.turns,
        };
      }).sort((a, b) => b.totalTokens - a.totalTokens);
    },

    getTrend(
      username: string,
      fromDate: string,
      toDate: string,
      family?: ModelFamily,
      tenantId?: string,
    ): DailyTrendRow[] {
      const src = rangeSource(fromDate, toDate);
      const params: Array<string | number | null> = [username, src.from, src.to];
      const tClause = tenantClause(tenantId, params);
      const rows = db.prepare(`
        SELECT
          date,
          model,
          SUM(input_tokens)          AS in_tok,
          SUM(output_tokens)         AS out_tok,
          SUM(cache_read_tokens)     AS cr_tok,
          SUM(cache_creation_tokens) AS cc_tok,
          SUM(cost_usd_micro)        AS cost_micro,
          SUM(turn_count)            AS turns
        FROM ${src.table}
        WHERE username = ? AND ${src.column} >= ? AND ${src.column} <= ?${familyClause(family)}${tClause}
        GROUP BY date, model
        ORDER BY date ASC
      `).all(...params) as Record<string, unknown>[];

      const byDate = new Map<string, DailyTrendRow>();
      for (const r of rows) {
        const row = aggregateSqlRow(r);
        const tokens = {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheCreationTokens: row.cacheCreationTokens,
        };
        const date = r.date as string;
        const current = byDate.get(date) ?? {
          date,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          turns: 0,
        };
        current.inputTokens += row.inputTokens;
        current.outputTokens += row.outputTokens;
        current.cacheReadTokens += row.cacheReadTokens;
        current.cacheCreationTokens += row.cacheCreationTokens;
        current.totalTokens += computeUsageTotalTokens(row.model, tokens);
        current.costUsd += row.costUsdMicro / 1e6;
        current.turns += row.turns;
        byDate.set(date, current);
      }
      return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    },

    getTrendAll(fromDate: string, toDate: string, family?: ModelFamily, tenantId?: string): DailyTrendRow[] {
      const src = rangeSource(fromDate, toDate);
      const params: Array<string | number | null> = [src.from, src.to];
      const tClause = tenantClause(tenantId, params);
      const rows = db.prepare(`
        SELECT
          date,
          model,
          SUM(input_tokens)          AS in_tok,
          SUM(output_tokens)         AS out_tok,
          SUM(cache_read_tokens)     AS cr_tok,
          SUM(cache_creation_tokens) AS cc_tok,
          SUM(cost_usd_micro)        AS cost_micro,
          SUM(turn_count)            AS turns
        FROM ${src.table}
        WHERE ${src.column} >= ? AND ${src.column} <= ?${familyClause(family)}${tClause}
        GROUP BY date, model
        ORDER BY date ASC
      `).all(...params) as Record<string, unknown>[];

      const byDate = new Map<string, DailyTrendRow>();
      for (const r of rows) {
        const row = aggregateSqlRow(r);
        const tokens = {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheCreationTokens: row.cacheCreationTokens,
        };
        const date = r.date as string;
        const current = byDate.get(date) ?? {
          date,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          turns: 0,
        };
        current.inputTokens += row.inputTokens;
        current.outputTokens += row.outputTokens;
        current.cacheReadTokens += row.cacheReadTokens;
        current.cacheCreationTokens += row.cacheCreationTokens;
        current.totalTokens += computeUsageTotalTokens(row.model, tokens);
        current.costUsd += row.costUsdMicro / 1e6;
        current.turns += row.turns;
        byDate.set(date, current);
      }
      return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    },

    getByChannel(
      fromDate: string,
      toDate: string,
      username?: string,
      family?: ModelFamily,
      tenantId?: string,
    ): ChannelAggregate[] {
      const src = rangeSource(fromDate, toDate);
      const famSql = familyClause(family);
      const params: Array<string | number | null> = [src.from, src.to];
      if (username) params.push(username);
      const userClause = username ? ' AND username = ?' : '';
      const tClause = tenantClause(tenantId, params);
      const sql = `SELECT channel,
             model,
             SUM(input_tokens)          AS in_tok,
             SUM(output_tokens)         AS out_tok,
             SUM(cache_read_tokens)     AS cr_tok,
             SUM(cache_creation_tokens) AS cc_tok,
             SUM(cost_usd_micro)        AS cost_micro,
             SUM(turn_count)            AS turns
           FROM ${src.table}
           WHERE ${src.column} >= ? AND ${src.column} <= ?${userClause}${famSql}${tClause}
           GROUP BY channel, model`;
      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

      const byChannel = new Map<string, ChannelAggregate>();
      for (const r of rows) {
        const row = aggregateSqlRow(r);
        const tokens = {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheCreationTokens: row.cacheCreationTokens,
        };
        const channel = r.channel as string;
        const current = byChannel.get(channel) ?? {
          channel,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 0,
          totalCostUsd: 0,
          totalTurns: 0,
        };
        current.inputTokens += row.inputTokens;
        current.outputTokens += row.outputTokens;
        current.cacheReadTokens += row.cacheReadTokens;
        current.cacheCreationTokens += row.cacheCreationTokens;
        current.totalTokens += computeUsageTotalTokens(row.model, tokens);
        current.totalCostUsd += row.costUsdMicro / 1e6;
        current.totalTurns += row.turns;
        byChannel.set(channel, current);
      }
      return Array.from(byChannel.values()).sort((a, b) => b.totalTokens - a.totalTokens);
    },

    getDataRange(tenantId?: string): DataRange {
      // tenantId === undefined → 跨组织全公司视角（platform admin）
      // tenantId === <slug>    → 仅该组织的 date 范围
      const params: Array<string | number | null> = [];
      const tClauseMain = tenantId !== undefined ? ' WHERE tenant_id = ?' : '';
      if (tenantId !== undefined) params.push(tenantId);

      const firstCostParams: Array<string | number | null> = [];
      let firstCostWhere = 'cost_usd_micro > 0';
      if (tenantId !== undefined) {
        firstCostWhere += ' AND tenant_id = ?';
        firstCostParams.push(tenantId);
      }
      const firstCost = db.prepare(
        `SELECT MIN(date) AS min_date FROM token_usage_daily WHERE ${firstCostWhere}`,
      ).get(...firstCostParams) as Record<string, unknown>;

      const row = db.prepare(`
        SELECT
          MIN(date) AS min_date,
          MAX(date) AS max_date
        FROM token_usage_daily${tClauseMain}
      `).get(...params) as Record<string, unknown>;

      return {
        earliestDate: (row.min_date as string | null) ?? null,
        latestDate: (row.max_date as string | null) ?? null,
        firstCostDate: (firstCost.min_date as string | null) ?? null,
      };
    },
  };
}
