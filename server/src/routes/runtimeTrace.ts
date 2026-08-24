/**
 * Agent 运行监测读 API（admin-only，租户隔离）
 *
 * 路由前缀：/api/admin/runtime/trace（在 app/routes.ts 通过 requireAdmin 包裹）
 *
 * 权限模型（2026-07-10 起从「平台 admin 硬拦」下放为 resolveTenant 模式，
 * 供租户综合分析复用效率诊断）：
 *   - 平台 admin：query.tenantId 任意（缺省 = 跨组织全量）
 *   - 组织 admin：强制锁定本租户；query 指定他人 tenantId → 403；
 *     run drill-down 访问他租户 run → 404（不泄露存在性）
 *   - 成本脱敏：组织 admin 且 tenant policy.showCost !== true 时，响应裁剪
 *     ¥ 实际成本字段（efficiency.cost 区、run billing 摘要），只保留 token 口径，
 *     并标 costRedacted: true。policy 不可得时宁可脱敏。
 *
 * 端点：
 *   GET /runs/:runId/events   → 单 run trace drill-down
 *     query:
 *       types?:            逗号分隔 event_type 白名单；缺省返回全部但排除
 *                          assistant_stream_event（仅服务跨进程实时投影的短期批次，
 *                          终态后由 retention 清理，不属于运行诊断事实）
 *       maxContentLength?: 大文本字段截断阈值（默认 4000，上限 65536）；截断的
 *                          事件对象标 truncated: true
 *   GET /recent-runs          → 最近 run 列表（updated_at DESC）
 *     query: status?（逗号分隔，白名单校验）/ hours?（默认 24，上限 720）
 *            / limit?（默认 50，上限 200）/ tenantId?
 *   GET /efficiency           → 时间窗内效率聚合（结局/工具/成本/长尾/审批/浪费）
 *     query: days?（默认 7，上限 30）/ from? + to?（成对 ISO-8601，[from,to)，
 *            跨度必须等于 days × 24h）/ tenantId?
 *
 * 设计取舍：
 * - 仅 PG runtime backend 可用；file backend / billing 未启用时 routes.ts 不挂载。
 * - run drill-down 组合三条现成读路径：RunStore.get + EventStore.listByRun +
 *   BillingStore.listUsageEvents（逐请求成本），不新增写路径。
 * - 效率聚合逻辑全部在 RuntimeEfficiencyQuery（runtime/efficiencyQuery.ts），路由层保持薄。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { isPlatformAdmin } from '../auth/types.js';
import { hasPlatformCapability } from '../auth/platformGovernance.js';
import type { PlatformEvent } from '../runtime/types.js';
import type { RunRecord } from '../runtime/runStore.js';
import type { BillingUsageEvent } from '../data/billing/types.js';
import type { UserStore } from '../data/users/store.js';
import { publicOperationalError, publicOperationalErrorMessage, type OperationalErrorLogger } from '../utils/publicOperationalError.js';
import { apiLogger } from '../utils/logger.js';
import type {
  EfficiencyQueryOptions,
  EfficiencyReport,
  RecentRunsQueryOptions,
  RecentRunSummary,
} from '../runtime/efficiencyQuery.js';

export interface RuntimeTraceRouterOptions {
  runStore: { get(runId: string): Promise<RunRecord | null> };
  eventStore: { listByRun(sessionId: string, runId: string): Promise<PlatformEvent[]> };
  billingStore: {
    listUsageEvents(query: { runId?: string; limit?: number }): Promise<BillingUsageEvent[]>;
  };
  userStore?: UserStore;
  efficiencyQuery: {
    listRecentRuns(opts: RecentRunsQueryOptions): Promise<RecentRunSummary[]>;
    getEfficiency(opts: EfficiencyQueryOptions): Promise<EfficiencyReport>;
  };
  /**
   * 组织 admin 成本可见性来源（tenant billing policy 的 showCost）。
   * 未注入或查询失败时对组织 admin 一律脱敏（fail-closed）。
   */
  getTenantPolicy?: (tenantId: string) => Promise<{ showCost?: boolean } | null | undefined>;
  /** 记录返回给调用方的 diagnosticId 与原始服务端错误之间的关联。 */
  logger?: OperationalErrorLogger;
}

/** run 状态白名单（recent-runs 的 status 过滤只接受这些值，防注入 + 防拼错悄悄空结果）。 */
const RUN_STATUS_WHITELIST = new Set([
  'pending',
  'running',
  'waiting_approval',
  'waiting_user',
  'waiting_hand',
  'completed',
  'failed',
  'cancelled',
]);

const TENANT_SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

const DEFAULT_MAX_CONTENT_LENGTH = 4000;
const MAX_CONTENT_LENGTH_CAP = 65536;

const runEventsQuerySchema = z.object({
  types: z.string().min(1).max(2000).optional(),
  maxContentLength: z.coerce.number().int().min(1).max(MAX_CONTENT_LENGTH_CAP).optional(),
});

const recentRunsQuerySchema = z.object({
  status: z.string().min(1).max(300).optional(),
  hours: z.coerce.number().int().min(1).max(720).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  tenantId: z.string().regex(TENANT_SLUG_RE).optional(),
});

const EFFICIENCY_DAY_MS = 24 * 60 * 60 * 1000;

const efficiencyQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  tenantId: z.string().regex(TENANT_SLUG_RE).optional(),
}).superRefine((query, ctx) => {
  const hasFrom = query.from !== undefined;
  const hasTo = query.to !== undefined;
  if (hasFrom !== hasTo) {
    ctx.addIssue({
      code: 'custom',
      path: hasFrom ? ['to'] : ['from'],
      message: 'from and to must be provided together',
    });
    return;
  }
  if (!query.from || !query.to) return;

  const fromMs = Date.parse(query.from);
  const toMs = Date.parse(query.to);
  if (fromMs >= toMs) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'from must be earlier than to' });
    return;
  }
  const days = query.days ?? 7;
  if (toMs - fromMs !== days * EFFICIENCY_DAY_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['to'],
      message: 'from/to span must equal days × 24 hours',
    });
  }
});

/**
 * RunRecord → 响应里的 run 摘要（只挑复盘需要的字段，不透出 lease/idempotency 等内部态）。
 */
export function pickRunSummary(
  run: RunRecord,
  redactOperationalError = false,
  logger?: OperationalErrorLogger,
): Record<string, unknown> {
  const statusReason = redactOperationalError && run.statusReason
    ? publicOperationalErrorMessage(
        run.statusReason,
        'RUNTIME_RUN_FAILED',
        undefined,
        logger,
        `run=${run.runId}`,
      )
    : undefined;
  return {
    status: run.status,
    statusReason: statusReason?.message ?? run.statusReason ?? null,
    ...(statusReason ? { errorCode: statusReason.code, diagnosticId: statusReason.diagnosticId } : {}),
    model: run.model ?? null,
    channel: run.channel ?? null,
    tenantId: run.tenantId ?? null,
    userId: run.userId ?? null,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    failedAt: run.failedAt ?? null,
    cancelledAt: run.cancelledAt ?? null,
    executionTarget: run.executionTarget ?? null,
    workspaceId: run.workspaceId ?? null,
    cumulativeInputTokens: run.cumulativeInputTokens ?? 0,
  };
}

/** 微元 → 元（保留 6 位内精度）。 */
function microToYuan(micro: number): number {
  return Number((micro / 1e6).toFixed(6));
}

/**
 * run 级 billing usage events → 成本摘要（逐请求明细按 request_index 升序）。
 * 导出供单测。
 */
export function summarizeRunBilling(events: BillingUsageEvent[]): {
  totalCostYuan: number;
  requestCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  models: string[];
  requests: Array<{
    requestIndex: number;
    actualModel: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    costYuan: number;
    createdAt: string;
  }>;
} {
  const sorted = [...events].sort(
    (a, b) => (a.requestIndex - b.requestIndex) || a.createdAt.localeCompare(b.createdAt),
  );
  let totalMicro = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  const models = new Set<string>();
  const requests = sorted.map((event) => {
    totalMicro += event.actualCostYuanMicro;
    inputTokens += event.inputTokens;
    cachedInputTokens += event.cachedInputTokens;
    outputTokens += event.outputTokens;
    reasoningTokens += event.reasoningTokens;
    const model = event.actualModel || event.modelValue;
    models.add(model);
    return {
      requestIndex: event.requestIndex,
      actualModel: model,
      inputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      outputTokens: event.outputTokens,
      reasoningTokens: event.reasoningTokens,
      costYuan: microToYuan(event.actualCostYuanMicro),
      createdAt: event.createdAt,
    };
  });
  return {
    totalCostYuan: microToYuan(totalMicro),
    requestCount: sorted.length,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    models: [...models],
    requests,
  };
}

/**
 * run billing 摘要成本脱敏（导出供单测）：去掉 ¥ 字段，保留 token 口径。
 */
export function redactBillingSummary(summary: ReturnType<typeof summarizeRunBilling>): {
  requestCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  models: string[];
  requests: Array<{
    requestIndex: number;
    actualModel: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    createdAt: string;
  }>;
  costRedacted: true;
} {
  const { totalCostYuan: _total, requests, ...rest } = summary;
  return {
    ...rest,
    requests: requests.map(({ costYuan: _cost, ...request }) => request),
    costRedacted: true,
  };
}

/**
 * 效率报告成本脱敏（导出供单测）：cost 区只保留 byModel 的 token 聚合与缓存命中率，
 * 去掉 totalCostYuan / perRun 分位 / failedRunsCostYuan 与 byModel.costYuan。
 */
export function sanitizeEfficiencyOperationalErrors(
  report: EfficiencyReport,
  logger?: OperationalErrorLogger,
  logContext?: string,
): EfficiencyReport {
  const grouped = new Map<string, EfficiencyReport['outcome']['errorReasons'][number]>();
  for (const item of report.outcome.errorReasons) {
    const safe = publicOperationalErrorMessage(
      item.reason,
      'RUNTIME_RUN_FAILED',
      undefined,
      logger,
      `${logContext ? `${logContext} ` : ''}sampleRun=${item.sampleRunId ?? 'unknown'}`,
    );
    const key = `${safe.code}\u001f${safe.message}`;
    const previous = grouped.get(key);
    grouped.set(key, previous
      ? { ...previous, count: previous.count + item.count }
      : { reason: safe.message, count: item.count, sampleRunId: item.sampleRunId });
  }
  return {
    ...report,
    outcome: { ...report.outcome, errorReasons: [...grouped.values()] },
  };
}

export function redactEfficiencyCost(report: EfficiencyReport): Omit<EfficiencyReport, 'cost'> & {
  cost: {
    byModel: Array<Omit<EfficiencyReport['cost']['byModel'][number], 'costYuan'>>;
    cacheHitRate: number | null;
  };
  costRedacted: true;
} {
  const { byModel, cacheHitRate } = report.cost;
  return {
    ...report,
    cost: {
      byModel: byModel.map(({ costYuan: _cost, ...model }) => model),
      cacheHitRate,
    },
    costRedacted: true,
  };
}

/**
 * 事件大字段截断（导出供单测）：
 * - 顶层字符串字段（content / error / modelContent 等）超限 → 截断
 * - toolCalls[].arguments（JSON 字符串）超限 → 截断
 * - 非字符串大对象（如 approval input）序列化后超限 → 整体替换为截断字符串
 * - 任一字段被截断时，该事件对象标 truncated: true
 * 事件信封字段（id/type/timestamp/sessionId/runId）永不截断。
 */
export function truncateTraceEvent(
  event: PlatformEvent,
  maxContentLength: number,
): Record<string, unknown> {
  let truncated = false;
  const clipString = (value: string): string => {
    if (value.length <= maxContentLength) return value;
    truncated = true;
    return `${value.slice(0, maxContentLength)}…[truncated ${value.length - maxContentLength} chars]`;
  };
  const clipValue = (value: unknown): unknown => {
    if (typeof value === 'string') return clipString(value);
    if (value !== null && typeof value === 'object') {
      let serialized: string;
      try {
        serialized = JSON.stringify(value) ?? '';
      } catch {
        return value; // 循环引用等异常：原样透传，不因截断逻辑丢数据
      }
      if (serialized.length > maxContentLength) return clipString(serialized);
      return value;
    }
    return value;
  };

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === 'id' || key === 'type' || key === 'timestamp' || key === 'sessionId' || key === 'runId') {
      out[key] = value;
      continue;
    }
    if (key === 'providerContinuation' && value && typeof value === 'object') {
      const continuation = value as {
        provider?: unknown;
        issuer?: unknown;
        accountBindingHash?: unknown;
        items?: unknown;
      };
      const items = Array.isArray(continuation.items) ? continuation.items : [];
      out[key] = {
        provider: continuation.provider,
        issuer: typeof continuation.issuer === 'string' ? '（已脱敏）' : undefined,
        accountBindingHash: continuation.accountBindingHash,
        itemCount: items.length,
        encryptedBytes: items.reduce((sum, item) => (
          sum + (
            item
            && typeof item === 'object'
            && typeof (item as { encrypted_content?: unknown }).encrypted_content === 'string'
              ? Buffer.byteLength((item as { encrypted_content: string }).encrypted_content, 'utf8')
              : 0
          )
        ), 0),
      };
      continue;
    }
    if (key === 'toolCalls' && Array.isArray(value)) {
      out[key] = value.map((call) => {
        if (call && typeof call === 'object' && typeof (call as { arguments?: unknown }).arguments === 'string') {
          return { ...(call as Record<string, unknown>), arguments: clipString((call as { arguments: string }).arguments) };
        }
        return call;
      });
      continue;
    }
    out[key] = clipValue(value);
  }
  if (truncated) out.truncated = true;
  return out;
}

/**
 * 将事件压缩为不含正文、思考、工具参数/结果或审批输入的诊断骨架。
 * 保留为显式脱敏导出能力；平台管理员详情接口不再默认调用。
 */
export function sanitizeTraceEvent(event: PlatformEvent): Record<string, unknown> {
  if (event.type === 'context_rewind') {
    return {
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      sessionId: event.sessionId,
      runId: event.runId,
      reason: event.reason,
      message: event.message,
      sourceModelRequestId: event.sourceModelRequestId,
      sourceAttemptId: event.sourceAttemptId,
      excludedEventIds: event.excludedEventIds,
      excludedToolCallIds: event.excludedToolCallIds,
      excludedStartSequence: event.excludedStartSequence,
      excludedEndSequence: event.excludedEndSequence,
      recoveryAttempt: event.recoveryAttempt,
      contentRedacted: true,
    };
  }
  const source = event as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const safeKeys = [
    'id', 'type', 'timestamp', 'sessionId', 'runId',
    'model', 'toolCallId', 'toolName', 'skillName', 'isError',
    'status', 'risk', 'durationMs', 'executionTarget',
    'approvalId', 'decision', 'previousStatus',
    'subtype', 'numTurns', 'handId', 'workspaceId', 'classifiedAs',
    'workerId', 'leaseExpiresAt', 'userId',
  ];
  for (const key of safeKeys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  if (source.error !== undefined) out.error = '执行失败（详细错误已脱敏）';
  if (source.reason !== undefined) out.reason = '原因已脱敏';
  if (Array.isArray(source.toolCalls)) {
    out.toolCalls = source.toolCalls.map((call) => {
      const value = call && typeof call === 'object' ? call as Record<string, unknown> : {};
      return {
        id: typeof value.id === 'string' ? value.id : '',
        name: typeof value.name === 'string' ? value.name : 'unknown',
        arguments: '（参数已脱敏）',
      };
    });
  }
  if ([
    'user_message',
    'memory_context',
    'assistant_thinking',
    'assistant_message',
    'tool_result',
    'tool_output_delta',
  ].includes(String(source.type))) {
    out.content = '（内容已脱敏）';
  }
  out.contentRedacted = true;
  return out;
}

/**
 * caller + query.tenantId → 生效租户范围（与 usage.ts 的 resolveQueryTenant 同规则）：
 *   - 平台 admin：tenantId = query.tenantId（undefined = 跨组织全量）
 *   - 组织 admin：强制 = caller.tenantId；query 指定他人 tenant → 403
 */
function resolveTenantScope(req: Request, queryTenantId: string | undefined):
  | { ok: true; platform: boolean; tenantId: string | undefined }
  | { ok: false; status: 401 | 403; error: string } {
  if (!req.user) return { ok: false, status: 401, error: 'Authentication required' };
  if (isPlatformAdmin(req.user)) {
    return { ok: true, platform: true, tenantId: queryTenantId };
  }
  if (queryTenantId !== undefined && queryTenantId !== req.user.tenantId) {
    return { ok: false, status: 403, error: '跨组织访问被拒绝' };
  }
  return { ok: true, platform: false, tenantId: req.user.tenantId };
}

export function createRuntimeTraceRouter(opts: RuntimeTraceRouterOptions): Router {
  const router = Router();
  const { runStore, eventStore, billingStore, userStore, efficiencyQuery, getTenantPolicy } = opts;
  const diagnosticLogger = opts.logger ?? apiLogger;

  /** 组织 admin 是否需要脱敏 ¥ 成本：policy.showCost === true 才放行；不可得时 fail-closed。 */
  async function shouldRedactCost(platform: boolean, tenantId: string | undefined): Promise<boolean> {
    if (platform) return false;
    if (!tenantId || !getTenantPolicy) return true;
    try {
      const policy = await getTenantPolicy(tenantId);
      return policy?.showCost !== true;
    } catch {
      return true;
    }
  }

  // 未认证 401（挂载层 requireAdmin 已保证 role=admin；这里防御性兜底）。
  router.use((req: Request, res: Response, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (req.user.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  });

  // ── Run trace drill-down：run 记录 + 逐请求成本 + 事件流 ──
  router.get('/runs/:runId/events', async (req: Request, res: Response) => {
    const runId = req.params.runId;
    if (!runId || runId.length > 200) {
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }
    const parsed = runEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
      return;
    }
    const maxContentLength = parsed.data.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
    const typeWhitelist = parsed.data.types
      ? new Set(parsed.data.types.split(',').map((t) => t.trim()).filter((t) => t.length > 0))
      : undefined;

    const scope = resolveTenantScope(req, undefined);
    if (!scope.ok) {
      res.status(scope.status).json({ error: scope.error });
      return;
    }

    try {
      const run = await runStore.get(runId);
      // 组织 admin 访问他租户 run：与"不存在"同样返回 404，不泄露 run 存在性
      if (!run || (!scope.platform && run.tenantId !== scope.tenantId)) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      const [events, usageEvents, orgCostRedacted] = await Promise.all([
        eventStore.listByRun(run.sessionId, runId),
        billingStore.listUsageEvents({ runId, limit: 1000 }),
        shouldRedactCost(scope.platform, scope.tenantId),
      ]);
      const filtered = events.filter((event) => (
        typeWhitelist ? typeWhitelist.has(event.type) : event.type !== 'assistant_stream_event'
      ));
      const billing = summarizeRunBilling(usageEvents);
      const redactCost = scope.platform
        ? !hasPlatformCapability(req.user, 'finance.read')
        : orgCostRedacted;
      res.json({
        runId,
        sessionId: run.sessionId,
        run: pickRunSummary(run, !scope.platform, diagnosticLogger),
        billing: redactCost ? redactBillingSummary(billing) : billing,
        events: filtered.map((event) => scope.platform
          ? truncateTraceEvent(event, maxContentLength)
          : sanitizeTraceEvent(event)),
      });
    } catch (err) {
      if (scope.platform) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Run trace query failed: ${msg}` });
      } else {
        res.status(500).json(publicOperationalError(
          err,
          'RUNTIME_TRACE_QUERY_FAILED',
          undefined,
          diagnosticLogger,
          req.originalUrl,
        ));
      }
    }
  });

  // ── 最近 run 列表（trace 入口） ──
  router.get('/recent-runs', async (req: Request, res: Response) => {
    const parsed = recentRunsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
      return;
    }
    let statuses: string[] | undefined;
    if (parsed.data.status !== undefined) {
      statuses = parsed.data.status.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      const invalid = statuses.find((s) => !RUN_STATUS_WHITELIST.has(s));
      if (invalid !== undefined || statuses.length === 0) {
        res.status(400).json({ error: `Invalid status: ${invalid ?? '(empty)'}` });
        return;
      }
    }
    const scope = resolveTenantScope(req, parsed.data.tenantId);
    if (!scope.ok) {
      res.status(scope.status).json({ error: scope.error });
      return;
    }
    try {
      const runs = await efficiencyQuery.listRecentRuns({
        ...(statuses ? { statuses } : {}),
        hours: parsed.data.hours ?? 24,
        limit: parsed.data.limit ?? 50,
        ...(scope.tenantId !== undefined ? { tenantId: scope.tenantId } : {}),
      });
      res.json({
        runs: runs.map((run) => enrichRecentRunSummary(
          run,
          userStore,
          !scope.platform,
          diagnosticLogger,
        )),
      });
    } catch (err) {
      if (scope.platform) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Recent runs query failed: ${msg}` });
      } else {
        res.status(500).json(publicOperationalError(
          err,
          'RUNTIME_RECENT_RUNS_QUERY_FAILED',
          undefined,
          diagnosticLogger,
          req.originalUrl,
        ));
      }
    }
  });

  // ── 效率聚合 ──
  router.get('/efficiency', async (req: Request, res: Response) => {
    const parsed = efficiencyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
      return;
    }
    const scope = resolveTenantScope(req, parsed.data.tenantId);
    if (!scope.ok) {
      res.status(scope.status).json({ error: scope.error });
      return;
    }
    try {
      const [report, redactCost] = await Promise.all([
        efficiencyQuery.getEfficiency({
          days: parsed.data.days ?? 7,
          ...(parsed.data.from !== undefined && parsed.data.to !== undefined
            ? { from: parsed.data.from, to: parsed.data.to }
            : {}),
          ...(scope.tenantId !== undefined ? { tenantId: scope.tenantId } : {}),
        }),
        shouldRedactCost(scope.platform, scope.tenantId),
      ]);
      // 组织总览只返回公共错误文案；净化先于成本裁剪，禁止绝对路径/release hash/stack 进入响应。
      const safeReport = scope.platform
        ? report
        : sanitizeEfficiencyOperationalErrors(report, diagnosticLogger, req.originalUrl);
      res.json(redactCost ? redactEfficiencyCost(safeReport) : safeReport);
    } catch (err) {
      if (scope.platform) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Efficiency query failed: ${msg}` });
      } else {
        res.status(500).json(publicOperationalError(
          err,
          'RUNTIME_EFFICIENCY_QUERY_FAILED',
          undefined,
          diagnosticLogger,
          req.originalUrl,
        ));
      }
    }
  });

  return router;
}

function enrichRecentRunSummary(
  run: RecentRunSummary,
  userStore?: UserStore,
  redactOperationalError = false,
  logger?: OperationalErrorLogger,
): RecentRunSummary & {
  username: string | null;
  realName: string | null;
  errorCode?: string;
  diagnosticId?: string;
} {
  const user = run.userId ? userStore?.findById(run.userId) : undefined;
  const matchesTenant = !!user && (!run.tenantId || user.tenantId === run.tenantId);
  const failure = redactOperationalError && run.statusReason
    ? publicOperationalErrorMessage(
        run.statusReason,
        'RUNTIME_RUN_FAILED',
        undefined,
        logger,
        `run=${run.runId}`,
      )
    : undefined;
  return {
    ...run,
    ...(failure ? {
      statusReason: failure.message,
      errorCode: failure.code,
      diagnosticId: failure.diagnosticId,
    } : {}),
    username: matchesTenant ? user.username : null,
    realName: matchesTenant ? user.realName ?? null : null,
  };
}
