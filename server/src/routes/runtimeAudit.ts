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
 * PR 10：解析 caller 应看到哪个 tenantId 切片。
 *   - 未认证 → 401
 *   - 平台 admin：query.tenantId 透传；未传 → undefined（跨组织）
 *   - 组织 admin：强制 caller.tenantId；query 指定别的 → 403
 */
function resolveAuditTenant(
  req: Request,
  queryTenantId: string | undefined,
): { ok: true; tenantId: string | undefined } | { ok: false; status: 401 | 403; error: string } {
  if (!req.user) return { ok: false, status: 401, error: 'Authentication required' };
  if (isPlatformAdmin(req.user)) return { ok: true, tenantId: queryTenantId };
  if (queryTenantId !== undefined && queryTenantId !== req.user.tenantId) {
    return { ok: false, status: 403, error: '跨组织访问被拒绝' };
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

    // 仅 DuckDB backend 实现这两个 optional 接口
    if (typeof auditQuery.listByRunIdGlobal !== 'function'
        || typeof auditQuery.summarizeByRunIdGlobal !== 'function') {
      res.status(503).json({
        error: 'Cross-session audit search requires audit.projection=duckdb',
      });
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
    // PR 10：tenantId 解析 — 组织 admin 强制本组织；平台 admin 可任意。
    const tenant = resolveAuditTenant(req, tenantId);
    if (!tenant.ok) {
      res.status(tenant.status).json({ error: tenant.error });
      return;
    }

    const queryOpts = {
      ...(limit !== undefined ? { limit } : { limit: 100 }),
      ...(offset !== undefined ? { offset } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(tenant.tenantId !== undefined ? { tenantId: tenant.tenantId } : {}),
    };

    try {
      const [entries, summary] = await Promise.all([
        auditQuery.listByRunIdGlobal(runId, queryOpts),
        auditQuery.summarizeByRunIdGlobal(runId, {
          ...(since !== undefined ? { since } : {}),
          ...(tenant.tenantId !== undefined ? { tenantId: tenant.tenantId } : {}),
        }),
      ]);
      res.json({
        runId,
        ...(since !== undefined ? { since } : {}),
        tenantId: tenant.tenantId ?? null,
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
      ...(limit !== undefined ? { limit } : { limit: 100 }),
      ...(offset !== undefined ? { offset } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(tenant.tenantId !== undefined ? { tenantId: tenant.tenantId } : {}),
    };

    try {
      const [entries, summary] = await Promise.all([
        runId
          ? auditQuery.listByRunId(sessionId, runId, queryOpts)
          : auditQuery.listBySessionId(sessionId, queryOpts),
        auditQuery.summarize(sessionId, {
          ...(since !== undefined ? { since } : {}),
          ...(tenant.tenantId !== undefined ? { tenantId: tenant.tenantId } : {}),
        }),
      ]);

      res.json({
        sessionId,
        runId: runId ?? null,
        ...(since !== undefined ? { since } : {}),
        tenantId: tenant.tenantId ?? null,
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
