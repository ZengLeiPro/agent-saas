/**
 * Runtime Audit Read API（admin-only）
 *
 * 路由前缀：/api/admin/runtime/audit（在 app/routes.ts 通过 requireAdmin 包裹）
 *
 * 端点：
 *   GET /runs/:runId                    → 跨 session 按 runId 全局查询
 *                                          (仅 audit.projection='duckdb' 时可用，
 *                                           file backend 返回 503)
 *     query: limit / offset / since
 *
 *   GET /:sessionId                     → 列出某 session 的 tool_audit + 汇总分布
 *     query:
 *       limit?:  number    (默认 100，硬上限 500)
 *       offset?: number    (默认 0)
 *       since?:  ISO 时间   仅返回 timestamp >= since
 *       runId?:  string    仅返回该 runId 的条目
 *
 * 设计取舍：
 * - 不做 UI / 不做 cursor 分页；admin 复盘时配合 since/runId 即可定位。
 * - 文件不存在或 sessionId 不存在：返回 entries=[] + 空 summary（200），
 *   避免 404 与"未跑过 raw runtime"两种情况混淆 admin 排查动线。
 * - sessionId 必须是合法 UUID 形态，避免被当作目录遍历入口。
 * - /runs/:runId 在 /:sessionId 之前注册，'runs' 字面量不会被 UUID 校验吞掉。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { isValidSessionId } from '../data/transcripts/projectKey.js';
import type { RuntimeAuditQuery } from '../runtime/auditQuery.js';
import { isPlatformAdmin } from '../auth/types.js';

export interface RuntimeAuditRouterOptions {
  auditQuery: RuntimeAuditQuery;
}

/**
 * 解析唯一允许的 tenant 切片。平台管理员也没有无租户全局路径；组织管理员
 * 指定外租户时返回 404，避免暴露租户是否存在。
 */
function resolveAuditTenant(
  req: Request,
  queryTenantId: string | undefined,
): { ok: true; tenantId: string } | { ok: false; status: 400 | 401 | 404; error: string } {
  if (!req.user) return { ok: false, status: 401, error: 'Authentication required' };
  if (isPlatformAdmin(req.user)) {
    if (!queryTenantId) {
      return { ok: false, status: 400, error: 'tenantId is required' };
    }
    return { ok: true, tenantId: queryTenantId };
  }
  if (queryTenantId !== undefined && queryTenantId !== req.user.tenantId) {
    return { ok: false, status: 404, error: 'Not found' };
  }
  return { ok: true, tenantId: req.user.tenantId };
}

const MAX_LIMIT = 500;

const TENANT_SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

const querySchema = z.object({
  limit: z.coerce.number().int().min(0).max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  since: z.string().min(1).optional(),
  runId: z.string().min(1).max(200).optional(),
  tenantId: z.string().regex(TENANT_SLUG_RE).optional(),
});

const crossSessionQuerySchema = z.object({
  limit: z.coerce.number().int().min(0).max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  since: z.string().min(1).optional(),
  tenantId: z.string().regex(TENANT_SLUG_RE).optional(),
});

export function createRuntimeAuditRouter(opts: RuntimeAuditRouterOptions): Router {
  const router = Router();
  const { auditQuery } = opts;

  // 跨 session：必须先注册（'runs' 字面量优先于 :sessionId 通配）
  router.get('/runs/:runId', async (req: Request, res: Response) => {
    const runId = req.params.runId;
    if (!runId || runId.length === 0 || runId.length > 200) {
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    const parsed = crossSessionQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
      return;
    }
    const { limit, offset, since, tenantId } = parsed.data;
    if (since !== undefined && !Number.isFinite(Date.parse(since))) {
      res.status(400).json({ error: 'Invalid since (expect ISO timestamp)' });
      return;
    }
    const tenant = resolveAuditTenant(req, tenantId);
    if (!tenant.ok) {
      res.status(tenant.status).json({ error: tenant.error });
      return;
    }

    // tenant 边界校验优先于 backend capability，避免任何无 tenantId 的路径。
    if (typeof auditQuery.listByRunIdGlobal !== 'function'
        || typeof auditQuery.summarizeByRunIdGlobal !== 'function') {
      res.status(503).json({
        error: 'Cross-session audit search requires audit.projection=duckdb',
      });
      return;
    }

    const queryOpts = {
      tenantId: tenant.tenantId,
      ...(limit !== undefined ? { limit } : { limit: 100 }),
      ...(offset !== undefined ? { offset } : {}),
      ...(since !== undefined ? { since } : {}),
    };

    try {
      const [entries, summary] = await Promise.all([
        auditQuery.listByRunIdGlobal(runId, queryOpts),
        auditQuery.summarizeByRunIdGlobal(runId, {
          tenantId: tenant.tenantId,
          ...(since !== undefined ? { since } : {}),
        }),
      ]);
      res.json({
        runId,
        ...(since !== undefined ? { since } : {}),
        tenantId: tenant.tenantId,
        limit: queryOpts.limit,
        offset: queryOpts.offset ?? 0,
        entries,
        summary,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Audit cross-session query failed: ${msg}` });
    }
  });

  router.get('/:sessionId', async (req: Request, res: Response) => {
    const sessionId = req.params.sessionId;
    if (!sessionId || !isValidSessionId(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId' });
      return;
    }

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
      return;
    }
    const { limit, offset, since, runId, tenantId } = parsed.data;
    // 校验 since：必须是可解析的时间戳；非法直接 400，避免悄悄忽略
    if (since !== undefined && !Number.isFinite(Date.parse(since))) {
      res.status(400).json({ error: 'Invalid since (expect ISO timestamp)' });
      return;
    }
    const tenant = resolveAuditTenant(req, tenantId);
    if (!tenant.ok) {
      res.status(tenant.status).json({ error: tenant.error });
      return;
    }

    const queryOpts = {
      tenantId: tenant.tenantId,
      ...(limit !== undefined ? { limit } : { limit: 100 }),
      ...(offset !== undefined ? { offset } : {}),
      ...(since !== undefined ? { since } : {}),
    };

    try {
      const [entries, summary] = await Promise.all([
        runId
          ? auditQuery.listByRunId(sessionId, runId, queryOpts)
          : auditQuery.listBySessionId(sessionId, queryOpts),
        auditQuery.summarize(sessionId, {
          tenantId: tenant.tenantId,
          ...(since !== undefined ? { since } : {}),
        }),
      ]);

      res.json({
        sessionId,
        runId: runId ?? null,
        ...(since !== undefined ? { since } : {}),
        tenantId: tenant.tenantId,
        limit: queryOpts.limit,
        offset: queryOpts.offset ?? 0,
        entries,
        summary,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Audit query failed: ${msg}` });
    }
  });

  return router;
}
