/**
 * Token Usage API（admin-only）
 *
 * 路由前缀：/api/admin/usage（在 app/routes.ts 通过 requireAdmin 包裹）
 *
 * 端点：
 *   GET /overview?range=7d|30d|mtd|today      → 期间总览（含活跃用户数、缓存命中率）
 *   GET /by-user?range=...                    → 用户排行（含 realName enrich）
 *   GET /by-model?range=...&username=...      → 模型分布（可选 username 过滤）
 *   GET /trend?username=...&range=...         → 单用户日趋势
 *   GET /data-range                           → 数据完整性元信息（最早/最晚/首条带 cost 的日期）
 *
 * range 参数：
 *   - 'today' = 今天（北京时间）
 *   - '7d'    = 最近 7 天（含今天）
 *   - '30d'   = 最近 30 天（含今天，默认）
 *   - 'mtd'   = month-to-date（本月初到今天）
 *   - 'all'   = 全部历史
 *   - 也支持显式 from/to（YYYY-MM-DD 或 YYYY-MM-DDTHH:mm，优先于 range）
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ModelFamily, TokenUsageStore } from '../data/usage/store.js';
import type { UserStore } from '../data/users/store.js';
import { isPlatformAdmin } from '../auth/types.js';
import { requirePlatformAdmin } from '../auth/middleware.js';

export interface UsageRouterOptions {
  tokenUsageStore: TokenUsageStore;
  /** 用于 enrich realName，可选 */
  userStore?: UserStore;
  /**
   * 手动触发全量回填（force=true 重扫 jsonl）。
   * 由 runtime 注入；未注入则 POST /rebuild 返回 503。
   * 实现应是 fire-and-forget 异步（路由立刻返回 202）。
   */
  triggerRebuild?: () => Promise<unknown>;
  /**
   * 成本可见性 policy（billing 的 showCost，2026-07-14）。
   * USD 成本是内部供应商成本口径，默认不暴露给组织 admin：
   *   - 平台 admin：永不脱敏
   *   - 组织 admin：policy.showCost === true 才放行
   *   - 未注入 / 查询异常：fail-closed（一律脱敏）
   */
  getTenantPolicy?: (tenantId: string) => Promise<{ showCost?: boolean } | null | undefined>;
}

/** 组织 admin 是否需要剥离 USD 成本字段（fail-closed，语义与 runtimeTrace.shouldRedactCost 对齐） */
async function shouldRedactCost(
  req: Request,
  getTenantPolicy: UsageRouterOptions['getTenantPolicy'],
): Promise<boolean> {
  if (!req.user) return true;
  if (isPlatformAdmin(req.user)) return false;
  if (!getTenantPolicy) return true;
  try {
    const policy = await getTenantPolicy(req.user.tenantId);
    return policy?.showCost !== true;
  } catch {
    return true;
  }
}

/** 从对象上剥离指定 key（不可变；用于删 costUsd/totalCostUsd） */
function omitKey<T extends Record<string, unknown>>(obj: T, key: string): Record<string, unknown> {
  const { [key]: _removed, ...rest } = obj;
  return rest;
}

/**
 * 把 caller 与 query.tenantId 解析成传给 store 的 tenantId（PR 10）。
 *
 * 规则：
 *   - 未认证 → 不可达（router 挂载在 requireAdmin 之后）
 *   - 平台 admin：tenantId 来自 query.tenantId；未传 → undefined（看全量）
 *   - 组织 admin：强制 = caller.tenantId；若 query 指定别的 tenant → 返回 403 信号
 *
 * 返回 { ok: true, tenantId } | { ok: false, status, error }
 */
function resolveQueryTenant(req: Request, queryTenantId: string | undefined):
  | { ok: true; tenantId: string | undefined }
  | { ok: false; status: 401 | 403; error: string } {
  if (!req.user) return { ok: false, status: 401, error: 'Authentication required' };
  if (isPlatformAdmin(req.user)) {
    return { ok: true, tenantId: queryTenantId };
  }
  if (queryTenantId !== undefined && queryTenantId !== req.user.tenantId) {
    return { ok: false, status: 403, error: '跨组织访问被拒绝' };
  }
  return { ok: true, tenantId: req.user.tenantId };
}

type RangePreset = 'today' | '7d' | '30d' | 'mtd' | 'all';

const DATE_OR_MINUTE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

const querySchema = z.object({
  range: z.enum(['today', '7d', '30d', 'mtd', 'all']).optional(),
  from: z.string().regex(DATE_OR_MINUTE_RE).optional(),
  to: z.string().regex(DATE_OR_MINUTE_RE).optional(),
  username: z.string().min(1).max(50).optional(),
  /** 模型家族筛选：claude / gpt / other；不传=全部 */
  family: z.enum(['claude', 'gpt', 'other']).optional(),
  /** PR 10：tenantId 过滤。平台 admin 可任意指定（含 undefined=全公司）；组织 admin 必须省略或 = 自己 */
  tenantId: z.string().min(2).max(31).regex(/^[a-z][a-z0-9-]{1,30}$/).optional(),
});

/** 取北京时间今天的 YYYY-MM-DD 字符串（与 store.formatBeijingDate 一致） */
function todayBeijing(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD + 偏移 N 天 → 新 YYYY-MM-DD */
function shiftDate(yyyyMmDd: string, deltaDays: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

/**
 * 把 query 参数解析为 (fromDate, toDate)。
 * - from/to 显式给定 → 直接用
 * - range='all' → from='0000-01-01'（store SQL 的 `date >= ?` 必然命中）
 * - 否则按 preset 计算
 */
function resolveRange(q: { range?: RangePreset; from?: string; to?: string }): {
  fromDate: string;
  toDate: string;
  range: RangePreset | 'custom';
} {
  const today = todayBeijing();
  if (q.from || q.to) {
    return {
      fromDate: q.from ?? '0000-01-01',
      toDate: q.to ?? today,
      range: 'custom',
    };
  }
  const range = q.range ?? '30d';
  switch (range) {
    case 'today':
      return { fromDate: today, toDate: today, range };
    case '7d':
      return { fromDate: shiftDate(today, -6), toDate: today, range };
    case '30d':
      return { fromDate: shiftDate(today, -29), toDate: today, range };
    case 'mtd':
      return { fromDate: today.slice(0, 7) + '-01', toDate: today, range };
    case 'all':
      return { fromDate: '0000-01-01', toDate: today, range };
  }
}

function rangeIsValid(fromDate: string, toDate: string): boolean {
  const from = fromDate.includes('T') ? fromDate : `${fromDate}T00:00`;
  const to = toDate.includes('T') ? toDate : `${toDate}T23:59`;
  return from <= to;
}

export function createUsageRouter(opts: UsageRouterOptions): Router {
  const { tokenUsageStore: store, userStore, triggerRebuild, getTenantPolicy } = opts;
  const router = Router();
  /** 防并发：一次只允许一个 rebuild 在跑 */
  let rebuildInFlight = false;

  // PR 10 起 realName enrich 内联到各 handler（需要按 tenantId 校验，不能裸 lookup）。
  // 仍然每次实时查 userStore，避免 user 更名后缓存过期。

  router.get('/overview', async (req: Request, res: Response) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
      return;
    }
    const { fromDate, toDate, range } = resolveRange(parsed.data);
    if (!rangeIsValid(fromDate, toDate)) {
      res.status(400).json({ error: 'Invalid range: from must be before or equal to to' });
      return;
    }
    const tenant = resolveQueryTenant(req, parsed.data.tenantId);
    if (!tenant.ok) {
      res.status(tenant.status).json({ error: tenant.error });
      return;
    }
    const family = parsed.data.family as ModelFamily | undefined;
    const redactCost = await shouldRedactCost(req, getTenantPolicy);
    const stats = store.getOverview(fromDate, toDate, family, tenant.tenantId);
    const payload = redactCost ? omitKey(stats as unknown as Record<string, unknown>, 'totalCostUsd') : stats;
    res.json({
      ...payload,
      range,
      family: family ?? null,
      tenantId: tenant.tenantId ?? null,
      ...(redactCost ? { costRedacted: true } : {}),
    });
  });

  router.get('/by-user', async (req: Request, res: Response) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
      return;
    }
    const { fromDate, toDate, range } = resolveRange(parsed.data);
    if (!rangeIsValid(fromDate, toDate)) {
      res.status(400).json({ error: 'Invalid range: from must be before or equal to to' });
      return;
    }
    const tenant = resolveQueryTenant(req, parsed.data.tenantId);
    if (!tenant.ok) {
      res.status(tenant.status).json({ error: tenant.error });
      return;
    }
    const family = parsed.data.family as ModelFamily | undefined;
    const redactCost = await shouldRedactCost(req, getTenantPolicy);
    const rows = store.getByUser(fromDate, toDate, family, tenant.tenantId);
    // realName enrich：仅在用户存在且 tenantId 匹配时填充（防止跨组织用户名碰撞泄漏 realName）。
    // 当前 username 全局唯一，但显式校验 tenantId 增加纵深防御。
    const enriched = rows.map((r) => {
      const user = userStore?.findByUsername(r.username);
      const base = redactCost ? omitKey(r as unknown as Record<string, unknown>, 'totalCostUsd') : r;
      return {
        ...base,
        realName: user && user.tenantId === r.tenantId ? user.realName : undefined,
      };
    });
    res.json({
      fromDate,
      toDate,
      range,
      family: family ?? null,
      tenantId: tenant.tenantId ?? null,
      users: enriched,
      ...(redactCost ? { costRedacted: true } : {}),
    });
  });

  router.get('/by-model', async (req: Request, res: Response) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
      return;
    }
    const { fromDate, toDate, range } = resolveRange(parsed.data);
    if (!rangeIsValid(fromDate, toDate)) {
      res.status(400).json({ error: 'Invalid range: from must be before or equal to to' });
      return;
    }
    const tenant = resolveQueryTenant(req, parsed.data.tenantId);
    if (!tenant.ok) {
      res.status(tenant.status).json({ error: tenant.error });
      return;
    }
    const family = parsed.data.family as ModelFamily | undefined;
    const redactCost = await shouldRedactCost(req, getTenantPolicy);
    const rows = store.getByModel(fromDate, toDate, parsed.data.username, family, tenant.tenantId);
    res.json({
      fromDate,
      toDate,
      range,
      username: parsed.data.username ?? null,
      family: family ?? null,
      tenantId: tenant.tenantId ?? null,
      models: redactCost ? rows.map((r) => omitKey(r as unknown as Record<string, unknown>, 'totalCostUsd')) : rows,
      ...(redactCost ? { costRedacted: true } : {}),
    });
  });

  router.get('/by-channel', async (req: Request, res: Response) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
      return;
    }
    const { fromDate, toDate, range } = resolveRange(parsed.data);
    if (!rangeIsValid(fromDate, toDate)) {
      res.status(400).json({ error: 'Invalid range: from must be before or equal to to' });
      return;
    }
    const tenant = resolveQueryTenant(req, parsed.data.tenantId);
    if (!tenant.ok) {
      res.status(tenant.status).json({ error: tenant.error });
      return;
    }
    const family = parsed.data.family as ModelFamily | undefined;
    const redactCost = await shouldRedactCost(req, getTenantPolicy);
    const rows = store.getByChannel(fromDate, toDate, parsed.data.username, family, tenant.tenantId);
    res.json({
      fromDate,
      toDate,
      range,
      username: parsed.data.username ?? null,
      family: family ?? null,
      tenantId: tenant.tenantId ?? null,
      channels: redactCost ? rows.map((r) => omitKey(r as unknown as Record<string, unknown>, 'totalCostUsd')) : rows,
      ...(redactCost ? { costRedacted: true } : {}),
    });
  });

  /**
   * 日趋势：
   *  - 传 username → 该用户日序列（getTrend）
   *  - 不传 username → 全公司日序列（getTrendAll，按日期合计所有用户）
   */
  router.get('/trend', async (req: Request, res: Response) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
      return;
    }
    const { fromDate, toDate, range } = resolveRange(parsed.data);
    if (!rangeIsValid(fromDate, toDate)) {
      res.status(400).json({ error: 'Invalid range: from must be before or equal to to' });
      return;
    }
    const tenant = resolveQueryTenant(req, parsed.data.tenantId);
    if (!tenant.ok) {
      res.status(tenant.status).json({ error: tenant.error });
      return;
    }
    const username = parsed.data.username ?? null;
    const family = parsed.data.family as ModelFamily | undefined;
    const redactCost = await shouldRedactCost(req, getTenantPolicy);
    const rows = username
      ? store.getTrend(username, fromDate, toDate, family, tenant.tenantId)
      : store.getTrendAll(fromDate, toDate, family, tenant.tenantId);
    // realName 仅同组织用户可见
    let realName: string | undefined = undefined;
    if (username) {
      const u = userStore?.findByUsername(username);
      if (u && (tenant.tenantId === undefined || u.tenantId === tenant.tenantId)) realName = u.realName;
    }
    res.json({
      fromDate,
      toDate,
      range,
      username,
      family: family ?? null,
      tenantId: tenant.tenantId ?? null,
      realName: realName ?? null,
      points: redactCost ? rows.map((r) => omitKey(r as unknown as Record<string, unknown>, 'costUsd')) : rows,
      ...(redactCost ? { costRedacted: true } : {}),
    });
  });

  /**
   * 手动触发全量重扫（force=true）。
   * - 异步执行，立即返回 202 + 提示文案
   * - 防并发：在跑期间再次调用返回 409
   * - 进度可通过轮询 /data-range 中的 rebuild 字段感知
   */
  // PR 10：rebuild 重扫整个 jsonl 树（全局副作用），仅平台 admin 可触发。
  // 组织 admin 想要自己组织的 usage 已经在 /overview 等端点里实时算好，不需要 rebuild。
  router.post('/rebuild', requirePlatformAdmin, (_req: Request, res: Response) => {
    if (!triggerRebuild) {
      res.status(503).json({ error: 'Rebuild trigger not available in this deployment' });
      return;
    }
    if (rebuildInFlight) {
      res.status(409).json({ error: 'Rebuild already in progress' });
      return;
    }
    rebuildInFlight = true;
    res.status(202).json({ started: true, message: '后台正在重扫 jsonl，完成后 /data-range 会刷新' });
    Promise.resolve(triggerRebuild())
      .catch(() => {
        // 错误已在 runtime 端 logged，这里不再处理
      })
      .finally(() => {
        rebuildInFlight = false;
      });
  });

  router.get('/data-range', (req: Request, res: Response) => {
    // tenantId query 解析与 7 个聚合端点一致；rebuild 状态对组织 admin 也可见（只读元信息）。
    const tenant = resolveQueryTenant(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenant.ok) {
      res.status(tenant.status).json({ error: tenant.error });
      return;
    }
    const range = store.getDataRange(tenant.tenantId);
    const rebuild = store.getRebuildState();
    res.json({
      ...range,
      tenantId: tenant.tenantId ?? null,
      rebuild: rebuild
        ? {
            lastRebuildAtMs: rebuild.lastRebuildAtMs,
            totalFilesScanned: rebuild.totalFilesScanned,
            totalRowsBuilt: rebuild.totalRowsBuilt,
          }
        : null,
    });
  });

  return router;
}
