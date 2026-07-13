/**
 * 公司级专职 Agent（Org Agent）REST 路由
 *
 * 权限三档（仿 agents.ts）：
 *   - 平台 admin：跨组织全量（?tenantId= 过滤）
 *   - 组织 admin：仅本租户，全字段读写；创建时 body.tenantId 强制覆写为自身租户
 *   - 普通用户：仅本租户 enabled + 被指派的安全公开视图（资料/示例问题/Skill 数量），
 *     不泄漏 instructions/guardrail/audience；未被指派 GET /:id 一律 404 防枚举
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { isPlatformAdmin } from '../auth/middleware.js';
import { auditLog } from '../data/login-logs/index.js';
import { isAssignedToOrgAgent, type OrgAgentStore } from '../data/orgAgents/store.js';
import type { OrgAgentRecord, OrgAgentSummary } from '../data/orgAgents/types.js';

export interface OrgAgentsRouterDeps {
  orgAgentStore: OrgAgentStore;
}

const audienceSchema = z.object({
  exposure: z.enum(['all', 'allow_users', 'deny_users']),
  usernames: z.array(z.string().min(1).max(100)).default([]),
});

const guardrailSchema = z.object({
  enabled: z.boolean(),
  scopeDescription: z.string().max(2000).default(''),
  rejectionMessage: z.string().min(1).max(500),
  strictness: z.enum(['strict', 'lenient']).default('strict'),
});

const starterPromptsSchema = z.array(z.string().trim().min(1).max(200))
  .max(6)
  .refine((items) => new Set(items).size === items.length, 'starter prompts must be unique');

const createOrgAgentSchema = z.object({
  tenantId: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(30),
  avatar: z.string().max(16).optional(),
  description: z.string().trim().max(500).default(''),
  starterPrompts: starterPromptsSchema.default([]),
  instructions: z.string().max(8000).default(''),
  allowedSkills: z.array(z.string().min(1).max(200)).default([]),
  audience: audienceSchema.default({ exposure: 'all', usernames: [] }),
  guardrail: guardrailSchema.default({
    enabled: false,
    scopeDescription: '',
    rejectionMessage: '这个问题超出了我的职责范围，暂时无法回答。',
    strictness: 'strict',
  }),
  enabled: z.boolean().default(true),
});

const updateOrgAgentSchema = z.object({
  name: z.string().trim().min(1).max(30).optional(),
  avatar: z.string().max(16).optional(),
  description: z.string().trim().max(500).optional(),
  starterPrompts: starterPromptsSchema.optional(),
  instructions: z.string().max(8000).optional(),
  allowedSkills: z.array(z.string().min(1).max(200)).optional(),
  audience: audienceSchema.optional(),
  guardrail: guardrailSchema.optional(),
  enabled: z.boolean().optional(),
});

function toSummary(record: OrgAgentRecord): OrgAgentSummary {
  return {
    id: record.id,
    name: record.name,
    ...(record.avatar ? { avatar: record.avatar } : {}),
    description: record.description,
    starterPrompts: [...record.starterPrompts],
    skillCount: record.allowedSkills.length,
  };
}

export function createOrgAgentsRouter(deps: OrgAgentsRouterDeps): Router {
  const { orgAgentStore } = deps;
  const router = Router();

  function requireUser(req: Request, res: Response): NonNullable<Request['user']> | null {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return null;
    }
    return user;
  }

  /**
   * admin 写路径守卫：非 admin 403；组织 admin 只能操作本租户记录（跨租户 403）。
   * 返回目标记录；不存在 404。
   */
  function authorizeAdminRecordAccess(req: Request, res: Response, id: string): OrgAgentRecord | null {
    const user = requireUser(req, res);
    if (!user) return null;
    if (user.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return null;
    }
    const record = orgAgentStore.get(id);
    if (!record) {
      res.status(404).json({ error: '企业专家不存在' });
      return null;
    }
    if (!isPlatformAdmin(user) && record.tenantId !== user.tenantId) {
      res.status(403).json({ error: '跨组织访问被拒绝' });
      return null;
    }
    return record;
  }

  // GET /api/org-agents — 按角色分档列表
  router.get('/', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      if (user.role === 'admin' && isPlatformAdmin(user)) {
        const tenantFilter = typeof req.query.tenantId === 'string' && req.query.tenantId
          ? String(req.query.tenantId)
          : undefined;
        const records = tenantFilter
          ? orgAgentStore.listByTenant(tenantFilter)
          : orgAgentStore.listAll();
        res.json(records);
        return;
      }
      if (user.role === 'admin') {
        res.json(orgAgentStore.listByTenant(user.tenantId));
        return;
      }
      // 普通用户：本租户 enabled + 被指派的裁剪视图
      res.json(orgAgentStore.listForUser(user.tenantId, user.username));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '获取失败' });
    }
  });

  // GET /api/org-agents/mine — 员工侧边栏数据源：被指派且 enabled 的裁剪视图
  router.get('/mine', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      res.json(orgAgentStore.listForUser(user.tenantId, user.username));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '获取失败' });
    }
  });

  // POST /api/org-agents — 创建（admin）
  router.post('/', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (user.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    const parsed = createOrgAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    // 组织 admin 强制归属自身租户（忽略伪造的 body.tenantId）；平台 admin 可指定，缺省落自身租户
    const tenantId = isPlatformAdmin(user)
      ? (parsed.data.tenantId || user.tenantId)
      : user.tenantId;
    try {
      const record = await orgAgentStore.create({
        tenantId,
        name: parsed.data.name,
        ...(parsed.data.avatar ? { avatar: parsed.data.avatar } : {}),
        description: parsed.data.description,
        starterPrompts: parsed.data.starterPrompts,
        instructions: parsed.data.instructions,
        allowedSkills: parsed.data.allowedSkills,
        audience: parsed.data.audience,
        guardrail: parsed.data.guardrail,
        enabled: parsed.data.enabled,
      }, user.username);
      auditLog(req, 'org_agent_created', `${record.name}（${record.id}, tenant=${record.tenantId}）`);
      res.status(201).json(record);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '创建失败' });
    }
  });

  // GET /api/org-agents/:id — admin 全字段；普通用户被指派时裁剪视图，否则 404（防枚举）
  router.get('/:id', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const record = orgAgentStore.get(req.params.id);
    if (user.role === 'admin') {
      if (!record) {
        res.status(404).json({ error: '企业专家不存在' });
        return;
      }
      if (!isPlatformAdmin(user) && record.tenantId !== user.tenantId) {
        res.status(403).json({ error: '跨组织访问被拒绝' });
        return;
      }
      res.json(record);
      return;
    }
    // 普通用户：同租户 + enabled + 被指派 → 裁剪视图；其余一律 404 防枚举
    if (
      !record
      || record.tenantId !== user.tenantId
      || !record.enabled
      || !isAssignedToOrgAgent(record, user.username)
    ) {
      res.status(404).json({ error: '企业专家不存在' });
      return;
    }
    res.json(toSummary(record));
  });

  // PATCH /api/org-agents/:id — 更新（admin + 租户守卫）
  router.patch('/:id', async (req, res) => {
    const record = authorizeAdminRecordAccess(req, res, req.params.id);
    if (!record) return;
    const parsed = updateOrgAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const updated = await orgAgentStore.update(record.id, parsed.data, req.user!.username);
      if (!updated) {
        res.status(404).json({ error: '企业专家不存在' });
        return;
      }
      const changed = Object.keys(parsed.data).join(', ');
      auditLog(req, 'org_agent_updated', `${updated.name}（${updated.id}${changed ? `, ${changed}` : ''}）`);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '更新失败' });
    }
  });

  // DELETE /api/org-agents/:id — 硬删（admin + 租户守卫；UI 引导用 enabled:false）
  router.delete('/:id', async (req, res) => {
    const record = authorizeAdminRecordAccess(req, res, req.params.id);
    if (!record) return;
    try {
      await orgAgentStore.remove(record.id);
      auditLog(req, 'org_agent_deleted', `${record.name}（${record.id}）`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '删除失败' });
    }
  });

  return router;
}
