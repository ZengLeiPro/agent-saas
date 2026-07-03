/**
 * /api/tenants — 组织元数据与组织配置管理接口
 *
 * - 组织 CRUD/status 仅平台 admin 可操作。
 * - 组织 settings 可由平台 admin 操作任意组织，也可由组织 admin 操作自己组织。
 */

import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';

import { isPlatformAdmin, requireAdmin, requirePlatformAdmin } from '../auth/middleware.js';
import { auditLog } from '../data/login-logs/index.js';
import { apiLogger } from '../utils/logger.js';
import type { TenantStore } from '../data/tenants/store.js';
import { TENANT_SLUG_PATTERN } from '../data/tenants/types.js';
import {
  MAX_COMPANY_INFO_CHARS,
  readTenantCompanyInfo,
  writeTenantCompanyInfo,
} from '../data/tenants/companyInfo.js';

const createTenantSchema = z.object({
  id: z.string().regex(
    TENANT_SLUG_PATTERN,
    'tenant id 必须以小写字母开头，可含小写字母/数字/连字符，长度 2-31',
  ),
  name: z.string().min(1, 'name 不能为空').max(100, 'name 不超过 100 字符'),
});

const updateTenantSchema = z.object({
  name: z.string().min(1, 'name 不能为空').max(100, 'name 不超过 100 字符').optional(),
});

const setDisabledSchema = z.object({
  disabled: z.boolean(),
});

const optionalNumber = z.preprocess(
  value => value === '' || value === null ? undefined : value,
  z.number().int().positive().optional(),
);

const tenantSettingsSchema = z.object({
  features: z.object({
    filesEnabled: z.boolean(),
    cronEnabled: z.boolean(),
    mcpEnabled: z.boolean(),
    customSkillsEnabled: z.boolean(),
    debugModeAllowed: z.boolean(),
    // optional：兼容不带新字段的旧客户端提交；缺省时 store merge 保留原值/默认 false
    autoCompactEnabled: z.boolean().optional(),
  }).optional(),
  quotas: z.object({
    maxUsers: optionalNumber,
    maxAdmins: optionalNumber,
    maxStorageMb: optionalNumber,
    monthlyTokenLimit: optionalNumber,
    maxTurnsPerRequest: optionalNumber,
    rateLimitMaxRequests: optionalNumber,
  }).optional(),
  models: z.object({
    defaultModel: z.string().max(200).optional(),
    allowedModels: z.array(z.string().max(200)).optional(),
    allowUserModelSwitch: z.boolean(),
    showGroupNames: z.boolean().optional(),
    showContextTokens: z.boolean().optional(),
    displayOverrides: z.record(z.string().max(200), z.object({
      displayName: z.string().max(100).optional(),
      description: z.string().max(500).optional(),
      recommended: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      groupDisplayName: z.string().max(100).optional(),
    })).optional(),
  }).optional(),
  mcp: z.object({
    allowTenantServers: z.boolean(),
    allowGlobalServers: z.boolean(),
    defaultEnabledServerIds: z.array(z.string().max(200)).optional(),
  }).optional(),
  branding: z.object({
    displayName: z.string().max(100).optional(),
    logoUrl: z.string().max(500).optional(),
    primaryColor: z.string().max(32).optional(),
  }).optional(),
  security: z.object({
    passwordMinLength: optionalNumber,
    sessionTtlHours: optionalNumber,
    requireDingtalkBinding: z.boolean(),
  }).optional(),
});

export interface CreateTenantsRouterOptions {
  tenantStore: TenantStore;
  /** sharedDir 用于读写每个组织独立的 company.md（注入到该组织 agent 的 system prompt）。 */
  sharedDir: string;
  /** 组织被禁用时的回调（断开 WS 连接 + 中止当前进程活跃流）。 */
  onTenantDisabled?: (tenantId: string) => void;
}

// company.md 体量上限：留 200k，与 MEMORY 对齐
const companyInfoSchema = z.object({
  content: z.string().max(MAX_COMPANY_INFO_CHARS),
});

function canAccessTenantSettings(reqUser: Request['user'], tenantId: string): boolean {
  if (!reqUser) return false;
  return isPlatformAdmin(reqUser) || reqUser.tenantId === tenantId;
}

/**
 * 新组织自动生成的最小 company.md。
 * 内容会原样注入该组织所有 agent 的 system prompt「公司事实基础」段，
 * 因此除了组织名，还写入一条给 agent 的行为指令：被问到公司情况时
 * 如实说明资料未完善并引导管理员补充，而不是凭空编造。
 */
function buildInitialCompanyInfo(tenantName: string): string {
  return [
    `# 组织名称：${tenantName}`,
    '',
    '（除组织名称外，本组织的详细资料尚未配置。当用户问及公司业务、产品、团队、制度等信息时，如实说明组织资料还未完善，不要编造；并提示：组织管理员可在管理后台「组织管理 → 公司信息」页补充，补充后新会话自动生效。）',
    '',
  ].join('\n');
}

export function createTenantsRouter(opts: CreateTenantsRouterOptions): Router {
  const router = Router();
  const { tenantStore, sharedDir } = opts;

  // GET /api/tenants — 列出所有组织（含 disabled）
  router.get('/', requirePlatformAdmin, (_req, res) => {
    res.json({ tenants: tenantStore.listAll() });
  });

  // ---------------------------------------------------------------------------
  // 组织独立 company.md（注入到该组织 agent 的 system prompt 作为 {{COMPANY_INFO}}）
  //
  // 注意：旧的 /company-info 全局接口已废弃；这里仅提供 tenant-scoped API。
  // 权限：平台 admin 可读写任意组织；组织 admin 仅可读写自己组织。
  // ---------------------------------------------------------------------------
  router.get('/:id/company-info', requireAdmin, async (req, res) => {
    if (!canAccessTenantSettings(req.user, req.params.id)) {
      res.status(403).json({ error: '跨组织访问被拒绝' });
      return;
    }
    if (!tenantStore.findById(req.params.id)) {
      res.status(404).json({ error: '组织不存在' });
      return;
    }
    try {
      const content = await readTenantCompanyInfo(sharedDir, req.params.id);
      res.json({ tenantId: req.params.id, content: content ?? '' });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '读取失败' });
    }
  });

  router.put('/:id/company-info', requireAdmin, async (req, res) => {
    if (!canAccessTenantSettings(req.user, req.params.id)) {
      res.status(403).json({ error: '跨组织访问被拒绝' });
      return;
    }
    if (!tenantStore.findById(req.params.id)) {
      res.status(404).json({ error: '组织不存在' });
      return;
    }
    const parsed = companyInfoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]!.message });
      return;
    }
    try {
      await writeTenantCompanyInfo(sharedDir, req.params.id, parsed.data.content);
      auditLog(req, 'tenant_updated', `${req.params.id} → company.md`);
      res.json({ ok: true, tenantId: req.params.id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '保存失败' });
    }
  });

  // GET /api/tenants/:id
  router.get('/:id', requirePlatformAdmin, (req, res) => {
    const tenant = tenantStore.findById(req.params.id);
    if (!tenant) {
      res.status(404).json({ error: '组织不存在' });
      return;
    }
    res.json(tenant);
  });

  // GET /api/tenants/:id/settings — 平台 admin 任意；组织 admin 仅自己
  router.get('/:id/settings', requireAdmin, (req, res) => {
    if (!canAccessTenantSettings(req.user, req.params.id)) {
      res.status(403).json({ error: '跨组织访问被拒绝' });
      return;
    }
    const settings = tenantStore.getSettings(req.params.id);
    if (!settings) {
      res.status(404).json({ error: '组织不存在' });
      return;
    }
    res.json({ tenantId: req.params.id, settings });
  });

  // PATCH /api/tenants/:id/settings — 平台 admin 任意；组织 admin 仅自己
  router.patch('/:id/settings', requireAdmin, async (req, res) => {
    if (!canAccessTenantSettings(req.user, req.params.id)) {
      res.status(403).json({ error: '跨组织访问被拒绝' });
      return;
    }
    const parsed = tenantSettingsSchema.safeParse(req.body?.settings ?? req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]!.message });
      return;
    }
    try {
      const settings = await tenantStore.updateSettings(req.params.id, parsed.data);
      auditLog(req, 'tenant_updated', `${req.params.id} → settings`);
      res.json({ tenantId: req.params.id, settings });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Tenant not found') {
        res.status(404).json({ error: '组织不存在' });
      } else {
        res.status(400).json({ error: msg });
      }
    }
  });

  // POST /api/tenants
  router.post('/', requirePlatformAdmin, async (req, res) => {
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]!.message });
      return;
    }
    try {
      const tenant = await tenantStore.create({
        id: parsed.data.id,
        name: parsed.data.name,
        createdBy: req.user!.sub,
      });
      // 冷启动：自动生成最小 company.md（含组织名 + 引导 agent 提示管理员完善）。
      // 写失败只 warn 不阻断——组织记录已建成，管理员随时可在组织资料页补写。
      try {
        await writeTenantCompanyInfo(sharedDir, tenant.id, buildInitialCompanyInfo(tenant.name));
      } catch (err) {
        apiLogger.warn(`初始化 company.md 失败（tenant=${tenant.id}）: ${err instanceof Error ? err.message : String(err)}`);
      }
      auditLog(req, 'tenant_created', `${tenant.id} (${tenant.name})`);
      res.status(201).json(tenant);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already exists')) {
        res.status(409).json({ error: 'tenant id 已存在' });
      } else if (msg.includes('Invalid tenant id')) {
        res.status(400).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // PATCH /api/tenants/:id — 改 name（slug 不可改）
  router.patch('/:id', requirePlatformAdmin, async (req, res) => {
    const parsed = updateTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]!.message });
      return;
    }
    try {
      const tenant = await tenantStore.update(req.params.id, { name: parsed.data.name });
      auditLog(req, 'tenant_updated', `${tenant.id} → name=${tenant.name}`);
      res.json(tenant);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Tenant not found') {
        res.status(404).json({ error: '组织不存在' });
      } else {
        res.status(400).json({ error: msg });
      }
    }
  });

  // PATCH /api/tenants/:id/status — disable / enable
  router.patch('/:id/status', requirePlatformAdmin, async (req, res) => {
    const parsed = setDisabledSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]!.message });
      return;
    }
    try {
      const tenant = await tenantStore.setDisabled(req.params.id, parsed.data.disabled, req.user!.sub);
      auditLog(req, parsed.data.disabled ? 'tenant_disabled' : 'tenant_enabled', tenant.id);
      if (parsed.data.disabled) {
        opts.onTenantDisabled?.(tenant.id);
      }
      res.json(tenant);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Tenant not found') {
        res.status(404).json({ error: '组织不存在' });
      } else if (msg.includes('Cannot disable')) {
        res.status(409).json({ error: msg });
      } else {
        res.status(400).json({ error: msg });
      }
    }
  });

  return router;
}
