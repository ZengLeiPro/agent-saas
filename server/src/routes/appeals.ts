/**
 * 员工申诉路由（2026-07 企业专家目录蓝图 v2 · B4 § 4.3.2 员工申诉设计）
 *
 * 三端点：
 *   POST /api/appeals                          — 员工提申诉（body: guardrailEventId + 可选 appealReason）
 *   GET  /api/tenant/appeals                   — 租户管理员看列表（分页 + status 过滤）
 *   POST /api/tenant/appeals/:id/handle        — 管理员处理（accepted / rejected + 可选 note）
 *
 * 权限：
 *   - 员工提申诉：会话中被拒答后才能触发；服务端按 guardrailEventId 从
 *     runtime_guardrail_events 反查 owner，userId 不匹配 → 403（防越权申诉他人的拒答）；
 *     tenantId 不匹配 → 404（防跨租户探测）；同一员工对同一 event 幂等（UNIQUE 索引）→ 409。
 *   - 管理员查看/处理：requireAdmin；组织 admin 强制自身租户；平台 admin 可 ?tenantId=。
 *
 * 依赖降级：
 *   - PgAppealStore 未装配（file backend）→ 503 全线（前端隐藏入口）。
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { isPlatformAdmin } from '../auth/types.js';
import { TENANT_SLUG_PATTERN } from '../data/tenants/types.js';
import type { AppealStore } from '../data/appeals/store.js';
import { DuplicateAppealError } from '../data/appeals/store.js';
import type { GuardrailAppealStatus } from '../data/appeals/types.js';

const APPEAL_STATUS_VALUES = ['pending', 'accepted', 'rejected'] as const;

const createAppealSchema = z.object({
  guardrailEventId: z.string().min(1).max(128),
  appealReason: z.string().trim().max(1000).optional(),
});

const listAppealsQuerySchema = z.object({
  tenantId: z.string().regex(TENANT_SLUG_PATTERN).optional(),
  status: z.enum(APPEAL_STATUS_VALUES).optional(),
  expertId: z.string().max(64).optional(),
  userId: z.string().max(128).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const handleAppealSchema = z.object({
  status: z.enum(['accepted', 'rejected']),
  note: z.string().trim().max(1000).optional(),
  /** 平台 admin 跨租户处理时需显式带；组织 admin 一律忽略此字段并强制自身租户 */
  tenantId: z.string().regex(TENANT_SLUG_PATTERN).optional(),
});

export interface AppealsRouterDeps {
  appealStore?: AppealStore;
}

/**
 * 员工提申诉端点。挂在 /api/appeals（任意登录用户可访问，服务端做 owner 守卫）。
 */
export function createAppealsRouter(deps: AppealsRouterDeps): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const store = requireStore(deps, res);
    if (!store) return;

    const parsed = createAppealSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
      return;
    }

    try {
      // 越权守卫：guardrailEventId 必须归属当前用户 + 当前租户。
      // 未记录 owner userId 的 guardrail event（旧数据或未登录场景）一律拒申诉——
      // 无法验证归属；宁可少收申诉不能收错。
      const owner = await store.getGuardrailEventOwner(parsed.data.guardrailEventId);
      if (!owner) {
        res.status(404).json({ error: '门禁事件不存在' });
        return;
      }
      if (owner.tenantId !== user.tenantId) {
        // 不泄漏跨租户 event 存在性
        res.status(404).json({ error: '门禁事件不存在' });
        return;
      }
      if (!owner.userId || owner.userId !== user.sub) {
        res.status(403).json({ error: '无权对该拒答提申诉' });
        return;
      }

      const record = await store.create({
        tenantId: user.tenantId,
        guardrailEventId: parsed.data.guardrailEventId,
        userId: user.sub,
        userMessage: owner.messageText,
        expertId: owner.orgAgentId,
        ...(parsed.data.appealReason ? { appealReason: parsed.data.appealReason } : {}),
      });
      res.status(201).json(record);
    } catch (err) {
      if (err instanceof DuplicateAppealError) {
        res.status(409).json({ error: '已存在针对该拒答的申诉', code: err.code });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : '提交申诉失败' });
    }
  });

  return router;
}

/**
 * 管理员端申诉队列。挂在 /api/tenant/appeals；requireAdmin 由挂载点提供或此处兜底。
 */
export function createTenantAppealsRouter(deps: AppealsRouterDeps): Router {
  const router = Router();

  router.use((req, res, next) => {
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

  router.get('/', async (req, res) => {
    const store = requireStore(deps, res);
    if (!store) return;
    const parsed = listAppealsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
      return;
    }
    const access = resolveTenant(req, parsed.data.tenantId);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    if (!access.tenantId) {
      res.status(400).json({ error: 'tenantId required' });
      return;
    }

    try {
      const result = await store.list({
        tenantId: access.tenantId,
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(parsed.data.expertId ? { expertId: parsed.data.expertId } : {}),
        ...(parsed.data.userId ? { userId: parsed.data.userId } : {}),
        ...(parsed.data.offset !== undefined ? { offset: parsed.data.offset } : {}),
        ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '查询申诉失败' });
    }
  });

  router.post('/:id/handle', async (req, res) => {
    const user = req.user!; // 已在 use 中挡下
    const store = requireStore(deps, res);
    if (!store) return;

    const parsed = handleAppealSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
      return;
    }
    const id = req.params.id;
    if (!id || typeof id !== 'string' || id.length > 128) {
      res.status(400).json({ error: 'Invalid appeal id' });
      return;
    }

    try {
      // 平台 admin 可 body 带 tenantId 跨租户处理；组织 admin 一律强制自身租户
      const tenantId = isPlatformAdmin(user)
        ? (parsed.data.tenantId ?? user.tenantId)
        : user.tenantId;
      const existing = await store.getById(id, tenantId);
      if (!existing) {
        res.status(404).json({ error: '申诉不存在' });
        return;
      }
      if (existing.status !== 'pending') {
        res.status(409).json({ error: '申诉已处理', currentStatus: existing.status });
        return;
      }
      const updated = await store.handle(id, tenantId, {
        status: parsed.data.status,
        handledBy: user.sub,
        ...(parsed.data.note ? { handleNote: parsed.data.note } : {}),
      });
      if (!updated) {
        // 并发处理竞态：读到 pending 后另一个 admin 抢先处理
        res.status(409).json({ error: '申诉已处理' });
        return;
      }
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '处理申诉失败' });
    }
  });

  return router;
}

function requireStore(deps: AppealsRouterDeps, res: Response): AppealStore | null {
  if (!deps.appealStore) {
    res.status(503).json({ error: '申诉功能需要 PG 数据面支持', code: 'APPEAL_STORE_UNAVAILABLE' });
    return null;
  }
  return deps.appealStore;
}

/** 平台 admin 可以看/处理任意租户；组织 admin 强制自身租户，传别人的 403 */
function resolveTenant(
  req: Request,
  requestedTenantId?: string,
): { ok: true; tenantId?: string } | { ok: false; status: number; error: string } {
  if (!req.user) return { ok: false, status: 401, error: 'Authentication required' };
  if (isPlatformAdmin(req.user)) return { ok: true, tenantId: requestedTenantId ?? req.user.tenantId };
  if (requestedTenantId && requestedTenantId !== req.user.tenantId) {
    return { ok: false, status: 403, error: 'Tenant access denied' };
  }
  return { ok: true, tenantId: req.user.tenantId };
}

export type { GuardrailAppealStatus };
