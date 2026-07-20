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
import multer from 'multer';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { z } from 'zod';
import { isPlatformAdmin } from '../auth/middleware.js';
import { isSuperAdmin } from '../auth/platformGovernance.js';
import { auditLog } from '../data/login-logs/index.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { isAssignedToOrgAgent, type OrgAgentStore } from '../data/orgAgents/store.js';
import type { OrgAgentRecord, OrgAgentSummary } from '../data/orgAgents/types.js';
import {
  checkTopicScope,
  type GuardrailCheckResult,
  type GuardrailModelConfig,
} from '../agent/guardrail.js';
import type { GuardrailEventStore } from '../data/guardrail/pgGuardrailEventStore.js';
import {
  computeOrgAgentUsageStats,
  type UsageStatsSessionReader,
} from './orgAgentUsageStats.js';

export interface OrgAgentsRouterDeps {
  orgAgentStore: OrgAgentStore;
  /** 图片头像落盘目录（缺省 ./data/org-agent-avatars，测试可不传） */
  orgAgentAvatarsDir?: string;
  /** 门禁模型链（reuse WebChannel 用的 getter；未装配 → gate-preview 503） */
  getGuardrailModelConfigs?: () => GuardrailModelConfig[];
  /** 使用统计派生数据源（未装配 → usage-stats 相关字段 0，不 503） */
  sessionProjectionStore?: UsageStatsSessionReader;
  guardrailEventStore?: GuardrailEventStore;
  /** gate-preview 每用户每分钟调用上限，默认 30（测试可调小） */
  gatePreviewRateLimit?: { maxPerMinute?: number };
  /** 测试注入 now 替身（用于窗口 KPI 与限流窗口时间） */
  now?: () => Date;
  /** 测试注入 checkTopicScope 替身（默认 reuse guardrail.ts checkTopicScope） */
  checkTopicScopeImpl?: typeof checkTopicScope;
}

const audienceSchema = z.object({
  exposure: z.enum(['all', 'allow_users', 'deny_users']),
  usernames: z.array(z.string().min(1).max(100)).default([]),
  // ★ 新增（2026-07-18 企业专家目录 MVP）：部门/角色白名单
  // MVP 阶段类型/schema 就位，UI 不暴露；5 周灰度后按反馈决定（蓝图 v2 § 4.1.4）
  departmentIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  roles: z.array(z.string().min(1).max(64)).max(30).optional(),
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
  // ★ 新增（2026-07-18 企业专家目录 MVP）：挂载租户知识库 id 列表
  allowedKnowledge: z.array(z.string().min(1).max(200)).max(20).optional(),
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

const usageStatsQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
});

const gatePreviewBodySchema = z.object({
  /** 测试消息（最长 2000，与门禁 prompt slice(0, 2000) 对齐） */
  testMessage: z.string().min(1).max(2000),
  /** 允许覆盖未保存的 scope 试验（否则使用 record.guardrail.scopeDescription） */
  overrideScopeDescription: z.string().max(2000).optional(),
  overrideStrictness: z.enum(['strict', 'lenient']).optional(),
  /** 最多 3 条历史用户消息，模拟 WebChannel 的接续判定上下文 */
  recentUserMessages: z.array(z.string().max(2000)).max(3).optional(),
});

function toSummary(record: OrgAgentRecord): OrgAgentSummary {
  return {
    id: record.id,
    name: record.name,
    ...(record.avatar ? { avatar: record.avatar } : {}),
    ...(record.avatarVersion ? { avatarVersion: record.avatarVersion } : {}),
    description: record.description,
    starterPrompts: [...record.starterPrompts],
    skillCount: record.allowedSkills.length,
  };
}

export function createOrgAgentsRouter(deps: OrgAgentsRouterDeps): Router {
  const { orgAgentStore } = deps;
  const avatarsDir = deps.orgAgentAvatarsDir ?? resolve(process.cwd(), './data/org-agent-avatars');
  const router = Router();

  // multer：文件名 = 记录 id + 原扩展名；目录 lazy 创建（避免测试环境目录副作用）
  const avatarStorage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        if (!existsSync(avatarsDir)) mkdirSync(avatarsDir, { recursive: true });
        cb(null, avatarsDir);
      } catch (err) {
        cb(err as Error, avatarsDir);
      }
    },
    filename: (req, file, cb) => {
      const ext = extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${req.params.id}${ext}`);
    },
  });
  const avatarUpload = multer({
    storage: avatarStorage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('仅支持 PNG/JPEG/WebP 格式'));
      }
    },
  });

  /** 删除某记录的头像文件（含历史扩展名残留）；容错，失败不阻断主流程 */
  function removeAvatarFiles(id: string, keep?: string): void {
    try {
      if (!existsSync(avatarsDir)) return;
      for (const f of readdirSync(avatarsDir)) {
        if (f.startsWith(`${id}.`) && f !== keep) unlinkSync(join(avatarsDir, f));
      }
    } catch { /* ignore cleanup errors */ }
  }

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
    if (isPlatformAdmin(user) && !isSuperAdmin(user) && record.tenantId === DEFAULT_TENANT_ID) {
      res.status(403).json({ error: '万神殿内部专家仅 @admin 可修改' });
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

  // GET /api/org-agents/avatar/:id — 公开：返回图片头像文件（注册必须先于 GET /:id）
  router.get('/avatar/:id', (req, res) => {
    const record = orgAgentStore.get(req.params.id);
    if (!record?.avatar || !record.avatar.startsWith('org-agent-avatars/')) {
      // 204 而非 404，避免 id 存在性枚举
      res.status(204).end();
      return;
    }
    const filePath = resolve(avatarsDir, '..', record.avatar);
    // 防路径穿越：resolve 后必须落在 avatarsDir 内
    if (!filePath.startsWith(avatarsDir + '/')) {
      res.status(404).end();
      return;
    }
    if (!existsSync(filePath)) {
      res.status(404).end();
      return;
    }
    if (req.query.v) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.set('Cache-Control', 'public, max-age=86400');
    }
    res.sendFile(filePath);
  });

  // POST /api/org-agents/:id/avatar — 上传图片头像（admin + 租户守卫）
  // 路径值仅在此写入；PATCH 的 avatar 字段 max(16) 只收 emoji，防止指向他租户文件
  router.post('/:id/avatar', (req, res, next) => {
    // 先做权限/租户守卫，再进 multer（避免越权者触发落盘）
    const record = authorizeAdminRecordAccess(req, res, req.params.id);
    if (!record) return;
    avatarUpload.single('avatar')(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: '文件大小超过 2MB 限制' });
          return;
        }
        res.status(400).json({ error: err instanceof Error ? err.message : '上传失败' });
        return;
      }
      next();
    });
  }, async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: '请选择图片文件' });
      return;
    }
    try {
      const filename = file.filename;
      removeAvatarFiles(req.params.id, filename);
      const version = Date.now();
      const updated = await orgAgentStore.update(
        req.params.id,
        { avatar: `org-agent-avatars/${filename}`, avatarVersion: version },
        req.user!.username,
      );
      if (!updated) {
        res.status(404).json({ error: '企业专家不存在' });
        return;
      }
      auditLog(req, 'org_agent_avatar_uploaded', `${updated.name}（${updated.id}）`);
      res.json({ avatar: `/api/org-agents/avatar/${req.params.id}?v=${version}`, avatarVersion: version });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '上传失败' });
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
    if (isPlatformAdmin(user) && !isSuperAdmin(user) && tenantId === DEFAULT_TENANT_ID) {
      res.status(403).json({ error: '委托管理员不能在万神殿创建企业专家' });
      return;
    }
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
      removeAvatarFiles(record.id);
      auditLog(req, 'org_agent_deleted', `${record.name}（${record.id}）`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '删除失败' });
    }
  });

  // GET /api/org-agents/:id/usage-stats — 30 天 KPI（admin + 租户守卫）
  //
  // 派生查询无 DDL：sessionProjectionStore（meta_json->>'orgAgentId' partial index）
  // + runtime_guardrail_events。PG 未装配时不 503，字段回落 0/null，前端隐藏卡片。
  router.get('/:id/usage-stats', async (req, res) => {
    const record = authorizeAdminRecordAccess(req, res, req.params.id);
    if (!record) return;
    const parsed = usageStatsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const stats = await computeOrgAgentUsageStats(
        {
          orgAgentId: record.id,
          tenantId: record.tenantId,
          ...(parsed.data.windowDays !== undefined ? { windowDays: parsed.data.windowDays } : {}),
        },
        {
          ...(deps.sessionProjectionStore ? { sessionProjectionStore: deps.sessionProjectionStore } : {}),
          ...(deps.guardrailEventStore ? { guardrailEventStore: deps.guardrailEventStore } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        },
      );
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '统计查询失败' });
    }
  });

  // POST /api/org-agents/:id/gate-preview — 门禁 dry-run（admin + 租户守卫 + rate limit）
  //
  // 只跑门禁小 LLM（`checkTopicScope`），不启动主 Agent。用途：编辑向导第 5 步管理员
  // 输入测试消息，立即看到 verdict + 是否会拒答，用于精调 scopeDescription。
  //
  // rate limit：**每 admin 每分钟 30 次**（防止刷成本）。窗口内存计数器，进程本地不共享；
  // 多进程部署时上限退化为 N * 30 但仍能限住绝大多数误用。
  const gatePreviewLimit = Math.max(1, deps.gatePreviewRateLimit?.maxPerMinute ?? 30);
  const gateRateBuckets = new Map<string, { windowStartMs: number; count: number }>();
  const gateRateNow = deps.now ?? (() => new Date());
  const scopeCheck = deps.checkTopicScopeImpl ?? checkTopicScope;

  router.post('/:id/gate-preview', async (req, res) => {
    const record = authorizeAdminRecordAccess(req, res, req.params.id);
    if (!record) return;
    const parsed = gatePreviewBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    // rate limit：key = user.sub（防同一 admin 多标签页并发）；缺 sub 兜底 username
    const rateKey = req.user!.sub || req.user!.username;
    const nowMs = gateRateNow().getTime();
    const bucket = gateRateBuckets.get(rateKey);
    if (bucket && nowMs - bucket.windowStartMs < 60_000) {
      if (bucket.count >= gatePreviewLimit) {
        const retryAfterMs = 60_000 - (nowMs - bucket.windowStartMs);
        res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        res.status(429).json({
          error: `每分钟最多 ${gatePreviewLimit} 次门禁试跑`,
          retryAfterMs,
        });
        return;
      }
      bucket.count += 1;
    } else {
      gateRateBuckets.set(rateKey, { windowStartMs: nowMs, count: 1 });
    }
    // bucket GC：进程运行期偶发扫，条目 > 500 时清过期（无副作用）
    if (gateRateBuckets.size > 500) {
      for (const [k, v] of gateRateBuckets) {
        if (nowMs - v.windowStartMs >= 60_000) gateRateBuckets.delete(k);
      }
    }

    const scopeDescription = parsed.data.overrideScopeDescription ?? record.guardrail.scopeDescription;
    if (!scopeDescription || !scopeDescription.trim()) {
      res.status(400).json({ error: '门禁 scopeDescription 为空，无法试跑（请先在专家配置或 overrideScopeDescription 中填入话题范围）' });
      return;
    }
    const strictness = parsed.data.overrideStrictness ?? record.guardrail.strictness;
    const guardrailConfigs = deps.getGuardrailModelConfigs?.() ?? [];
    if (guardrailConfigs.length === 0) {
      res.status(503).json({ error: '门禁模型未装配（getGuardrailModelConfigs 为空）' });
      return;
    }

    try {
      const check: GuardrailCheckResult = await scopeCheck(
        {
          message: parsed.data.testMessage,
          scopeDescription,
          strictness,
          recentUserMessages: parsed.data.recentUserMessages ?? [],
        },
        guardrailConfigs,
      );
      // 三态 verdict → 前端友好字段
      // - inScope: 门禁判定"属于范围"（in_scope；uncertain 视为不明确 → false）
      // - confidence: 由 verdict + source 合成（当前门禁 prompt 未回吐置信度，只能语义映射）
      //   in_scope/model → 0.9；off_topic/model → 0.9（拒答很确定）；uncertain → 0.5；fail_open → 0.5
      // - reason: verdict 描述（供前端显示"判定原因"）
      const inScope = check.verdict === 'in_scope';
      const confidence = confidenceForVerdict(check);
      const reason = reasonForVerdict(check);
      const wouldReject = check.verdict === 'off_topic';
      // 无副作用的 preview 调用不写审计日志（避免与 LoginEvent 类型面板耦合）；
      // 需要审计时可后续把 'org_agent_gate_preview' 加入 LoginEvent 联合类型。
      res.json({
        inScope,
        confidence,
        reason,
        latencyMs: check.latencyMs,
        verdict: check.verdict,
        source: check.source,
        ...(check.model ? { model: check.model } : {}),
        wouldReject,
        ...(wouldReject ? { rejectionPreview: record.guardrail.rejectionMessage } : {}),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '门禁试跑失败' });
    }
  });

  return router;
}

function confidenceForVerdict(check: GuardrailCheckResult): number {
  if (check.source === 'fail_open') return 0.5;
  switch (check.verdict) {
    case 'in_scope': return 0.9;
    case 'off_topic': return 0.9;
    case 'uncertain': return 0.5;
    default: return 0.5;
  }
}

function reasonForVerdict(check: GuardrailCheckResult): string {
  if (check.source === 'fail_open') return '门禁模型全链失败，默认放行（fail-open）';
  switch (check.verdict) {
    case 'in_scope': return '话题属于范围';
    case 'off_topic': return '话题超出范围';
    case 'uncertain': return '门禁拿不准，按 strictness 处理';
    default: return check.verdict;
  }
}
