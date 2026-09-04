/**
 * /api/tenants — 组织元数据与组织配置管理接口
 *
 * - 组织 CRUD/status 仅平台 admin 可操作。
 * - 组织 settings 可由平台 admin 操作任意组织，也可由组织 admin 操作自己组织。
 */

import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';

import { isDebugModeAvailable, type TenantMemoryFeatureStatusMap } from '../../../shared/src/types/tenant.js';
import { isPlatformAdmin, requireAdmin, requirePlatformAdmin } from '../auth/middleware.js';
import { auditLog } from '../data/login-logs/index.js';
import {
  GovernanceAuditUnavailableError,
  governanceDigest,
  recordGovernanceIntent,
  type GovernanceAuditStore,
} from '../data/governance-audit/index.js';
import { apiLogger } from '../utils/logger.js';
import type { TenantStore } from '../data/tenants/store.js';
import { withTenantDebugModeLock } from '../data/tenants/debugModeLock.js';
import type { UserStore } from '../data/users/store.js';
import { DEFAULT_TENANT_ID, TENANT_SLUG_PATTERN } from '../data/tenants/types.js';
import type { DurableTenantDeletionExecutor, TenantDeletionReport } from '../data/tenants/cleanup.js';
import {
  MAX_COMPANY_INFO_CHARS,
  readTenantCompanyInfo,
  writeTenantCompanyInfo,
} from '../data/tenants/companyInfo.js';
import { provisionTenant } from '../data/tenants/provision.js';
import {
  MAX_TENANT_INSTRUCTIONS_CHARS,
  readTenantInstructions,
  writeTenantInstructions,
} from '../data/tenants/instructions.js';
import type { OrgAgentStore } from '../data/orgAgents/store.js';
import type { PgEntitlementStore } from '../data/entitlements/store.js';
import { tenantSettingsPolicyError, tenantSettingsSchema } from './tenantSettingsValidation.js';

const createTenantSchema = z.object({
  id: z.string().regex(
    TENANT_SLUG_PATTERN,
    'tenant id 必须以小写字母开头，可含小写字母/数字/连字符，长度 2-31',
  ),
  name: z.string().trim().min(1, 'name 不能为空').max(100, 'name 不超过 100 字符'),
});

const updateTenantSchema = z.object({
  name: z.string().min(1, 'name 不能为空').max(100, 'name 不超过 100 字符').optional(),
});

const setDisabledSchema = z.object({
  disabled: z.boolean(),
});

const reorderTenantsSchema = z.object({
  ids: z.array(z.string().regex(TENANT_SLUG_PATTERN)).min(1)
    .refine(ids => new Set(ids).size === ids.length, 'ids 不可重复'),
});

const deleteTenantSchema = z.object({
  confirm: z.string().min(1),
});

const replayTenantDeletionSchema = z.object({
  expectedRevision: z.number().int().positive(),
  additionalAttempts: z.number().int().min(1).max(20).optional(),
});

export interface CreateTenantsRouterOptions {
  tenantStore: TenantStore;
  /** 用户存储用于上级关闭时清理组织成员的个人调试开关。 */
  userStore?: UserStore;
  /** sharedDir 用于读写每个组织独立的 company.md（注入到该组织 agent 的 system prompt）。 */
  sharedDir: string;
  /** 组织被禁用时的回调（断开 WS 连接 + 中止当前进程活跃流）。 */
  onTenantDisabled?: (tenantId: string) => void;
  /** 记忆能力配置态/实际生效态；缺省仅用于路由单测和旧嵌入方兼容。 */
  resolveMemoryFeatureStatus?: (tenantId: string) => TenantMemoryFeatureStatusMap;
  /** @deprecated 仅保留嵌入方类型兼容；DELETE 不再执行非持久的同步 hard delete。 */
  deleteTenantResources?: (tenantId: string) => Promise<TenantDeletionReport>;
  /** PostgreSQL-backed durable tenant deletion state machine. */
  tenantDeletionExecutor?: DurableTenantDeletionExecutor;
  /** 高风险组织删除的独立 append-only 治理审计；缺失时删除 fail closed。 */
  governanceAuditStore?: GovernanceAuditStore;
  /**
   * ★ 新增（2026-07-18 企业专家目录 MVP）：orgAgentStore
   * 用于新租户开通时自动 seed 3 个种子专家模板（enabled=false，管理员启用）。
   * 缺省时静默跳过 seed（保持向后兼容，不阻断租户创建）。
   */
  orgAgentStore?: OrgAgentStore;
  /** 新组织治理基线必须与组织创建同成败；生产 PG runtime 必须装配。 */
  entitlementStore?: Pick<PgEntitlementStore, 'provisionTenantGovernance' | 'deleteTenantGovernance'>;
  legacyWriteGate?: {
    assertLegacyWriteAllowed(input: { actor: 'user' | 'service'; compatibilityProjection: boolean }): Promise<void>;
  };
}

// company.md 体量上限：留 200k，与 MEMORY 对齐
const companyInfoSchema = z.object({
  content: z.string().max(MAX_COMPANY_INFO_CHARS),
});

// instructions.md 是行为规则不是事实，上限刻意远小于 company.md
const tenantInstructionsSchema = z.object({
  content: z.string().max(MAX_TENANT_INSTRUCTIONS_CHARS),
});

function canAccessTenantSettings(reqUser: Request['user'], tenantId: string): boolean {
  if (!reqUser) return false;
  return isPlatformAdmin(reqUser) || reqUser.tenantId === tenantId;
}

export function createTenantsRouter(opts: CreateTenantsRouterOptions): Router {
  const router = Router();
  router.use(async (req, res, next) => {
    const createsTenant = req.method === 'POST' && req.path === '/';
    const deletesTenant = req.method === 'DELETE' && /^\/[^/]+$/.test(req.path);
    const changesGovernedState = req.method === 'PATCH'
      && (/^\/[^/]+\/status$/.test(req.path) || /^\/[^/]+\/settings$/.test(req.path));
    if (!(createsTenant || deletesTenant || changesGovernedState) || !opts.legacyWriteGate) return next();
    // DELETE is no longer a legacy mutation when backed by the durable job executor.
    if (deletesTenant && opts.tenantDeletionExecutor) return next();
    if (deletesTenant || changesGovernedState) {
      res.status(409).json({
        error: '旧版 Tenant 治理写入口已封闭，请使用治理 API 或 Change Job',
        code: 'MIGRATION_LEGACY_WRITE_SEALED',
      });
      return;
    }
    try {
      await opts.legacyWriteGate.assertLegacyWriteAllowed({ actor: 'user', compatibilityProjection: false });
      next();
    } catch {
      res.status(409).json({
        error: '旧版 Tenant 治理写入口已封闭，请使用治理 API 或 Change Job',
        code: 'MIGRATION_LEGACY_WRITE_SEALED',
      });
    }
  });
  const { tenantStore, userStore, sharedDir } = opts;
  const memoryFeatureStatusFor = (tenantId: string) => opts.resolveMemoryFeatureStatus?.(tenantId);

  // GET /api/tenants — 列出所有组织（含 disabled）
  router.get('/', requirePlatformAdmin, (_req, res) => {
    res.json({ tenants: tenantStore.listAll() });
  });

  // PATCH /api/tenants — 持久化全局组织顺序；所有组织选择器沿用该顺序
  router.patch('/', requirePlatformAdmin, async (req, res) => {
    const parsed = reorderTenantsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]!.message });
      return;
    }
    try {
      const tenants = await tenantStore.reorder(parsed.data.ids);
      auditLog(req, 'tenant_updated', `order=${parsed.data.ids.join(',')}`);
      res.json({ tenants });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
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

  // ---------------------------------------------------------------------------
  // 组织自定义规则 instructions.md（注入为 {{TENANT_INSTRUCTIONS}}）
  //
  // 与 company-info 的差别是语义而非形态：那边是组织事实，这边是行为规则，
  // 注入位置更靠后，可覆盖平台默认风格（安全边界除外）。权限口径完全一致。
  // ---------------------------------------------------------------------------
  router.get('/:id/instructions', requireAdmin, async (req, res) => {
    if (!canAccessTenantSettings(req.user, req.params.id)) {
      res.status(403).json({ error: '跨组织访问被拒绝' });
      return;
    }
    if (!tenantStore.findById(req.params.id)) {
      res.status(404).json({ error: '组织不存在' });
      return;
    }
    try {
      const content = await readTenantInstructions(sharedDir, req.params.id);
      res.json({ tenantId: req.params.id, content: content ?? '' });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '读取失败' });
    }
  });

  router.put('/:id/instructions', requireAdmin, async (req, res) => {
    if (!canAccessTenantSettings(req.user, req.params.id)) {
      res.status(403).json({ error: '跨组织访问被拒绝' });
      return;
    }
    if (!tenantStore.findById(req.params.id)) {
      res.status(404).json({ error: '组织不存在' });
      return;
    }
    const parsed = tenantInstructionsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]!.message });
      return;
    }
    try {
      await writeTenantInstructions(sharedDir, req.params.id, parsed.data.content);
      auditLog(req, 'tenant_updated', `${req.params.id} → instructions.md`);
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
    res.json({
      tenantId: req.params.id,
      settings,
      memoryFeatureStatus: memoryFeatureStatusFor(req.params.id),
    });
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
    const current = tenantStore.getSettings(req.params.id);
    if (!current) {
      res.status(404).json({ error: '组织不存在' });
      return;
    }
    const policyError = tenantSettingsPolicyError(parsed.data, current, isPlatformAdmin(req.user));
    if (policyError) {
      res.status(policyError.status).json({ error: policyError.error });
      return;
    }
    try {
      const settings = await withTenantDebugModeLock(req.params.id, async () => {
        const nextSettings = await tenantStore.updateSettings(req.params.id, parsed.data);
        if (userStore && !isDebugModeAvailable(req.params.id, nextSettings.features)) {
          await userStore.disableDebugModeForTenant(req.params.id);
        }
        return nextSettings;
      });
      auditLog(req, 'tenant_updated', `${req.params.id} → settings`);
      res.json({
        tenantId: req.params.id,
        settings,
        memoryFeatureStatus: memoryFeatureStatusFor(req.params.id),
      });
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
      const tenant = await provisionTenant({
        tenantStore,
        sharedDir,
        ...(opts.orgAgentStore ? { orgAgentStore: opts.orgAgentStore } : {}),
        ...(opts.entitlementStore ? { entitlementStore: opts.entitlementStore } : {}),
      }, {
        id: parsed.data.id,
        name: parsed.data.name,
        createdBy: req.user!.sub,
      });
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

  // GET /api/tenants/:id/deletion-jobs/:jobId — durable status/receipt.
  router.get('/:id/deletion-jobs/:jobId', requirePlatformAdmin, async (req, res) => {
    if (!opts.tenantDeletionExecutor) {
      res.status(501).json({ error: '当前服务未启用持久化组织删除任务' });
      return;
    }
    const receipt = await opts.tenantDeletionExecutor.get(req.params.id, req.params.jobId);
    if (!receipt) {
      res.status(404).json({ error: '组织删除任务不存在' });
      return;
    }
    res.json(receipt);
  });

  // POST /api/tenants/:id/deletion-jobs/:jobId/replay — revision-fenced terminal replay.
  router.post('/:id/deletion-jobs/:jobId/replay', requirePlatformAdmin, async (req, res) => {
    const parsed = replayTenantDeletionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]!.message });
      return;
    }
    if (!opts.tenantDeletionExecutor) {
      res.status(501).json({ error: '当前服务未启用持久化组织删除任务' });
      return;
    }
    try {
      await recordGovernanceIntent(opts.governanceAuditStore, req.user!, {
        action: 'tenant.delete.replay', targetType: 'tenant_deletion_job', targetId: req.params.jobId,
        targetTenantId: req.params.id, purpose: 'platform_governance', reason: 'operator_replay',
        metadata: {
          expectedRevision: parsed.data.expectedRevision,
          additionalAttempts: parsed.data.additionalAttempts ?? 5,
          // Replay intent is written after the original retention pass; classify it at creation
          // so rejected/stale replay attempts cannot leave a new unretained tenant audit row.
          tenantDeletedAt: new Date().toISOString(),
        },
      });
      const receipt = await opts.tenantDeletionExecutor.replay({
        tenantId: req.params.id,
        jobId: req.params.jobId,
        expectedRevision: parsed.data.expectedRevision,
        requestedBy: req.user!.sub,
        ...(parsed.data.additionalAttempts !== undefined
          ? { additionalAttempts: parsed.data.additionalAttempts }
          : {}),
      });
      auditLog(req, 'tenant_deleted',
        `${req.params.id} replay job=${req.params.jobId} revision=${parsed.data.expectedRevision}`);
      res.status(receipt.job.status === 'succeeded' ? 200 : 202).json(receipt);
    } catch (err) {
      if (err instanceof GovernanceAuditUnavailableError) {
        res.status(503).json({ code: err.code, error: err.message });
        return;
      }
      const code = err instanceof Error ? err.message : String(err);
      if (code === 'CHANGE_JOB_NOT_FOUND') {
        res.status(404).json({ code, error: '组织删除任务不存在' });
        return;
      }
      if (['CHANGE_JOB_VERSION_CONFLICT', 'CHANGE_JOB_INVALID_TRANSITION', 'CHANGE_JOB_TARGET_BUSY'].includes(code)) {
        res.status(409).json({ code, error: '组织删除任务状态已变化，请刷新后重试' });
        return;
      }
      apiLogger.error(`重放组织删除任务失败（tenant=${req.params.id}, job=${req.params.jobId}）: ${code}`);
      res.status(500).json({ error: code });
    }
  });

  // DELETE /api/tenants/:id — create/reuse and drive a durable deletion job.
  router.delete('/:id', requirePlatformAdmin, async (req, res) => {
    const parsed = deleteTenantSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]!.message });
      return;
    }
    if (parsed.data.confirm !== req.params.id) {
      res.status(400).json({ error: '请填写完全一致的组织 slug 以确认删除' });
      return;
    }
    if (req.params.id === DEFAULT_TENANT_ID) {
      res.status(409).json({ error: `Cannot delete the default tenant "${DEFAULT_TENANT_ID}"` });
      return;
    }
    if (!opts.tenantDeletionExecutor) {
      res.status(501).json({ error: '当前服务未启用持久化组织删除任务' });
      return;
    }
    const idempotencyKey = String(req.header('Idempotency-Key') || `tenant-delete:${req.params.id}`).trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      res.status(400).json({ error: 'Idempotency-Key 长度必须为 1-200' });
      return;
    }
    const tenant = tenantStore.findById(req.params.id);
    if (!tenant) {
      const existing = await opts.tenantDeletionExecutor.findByIdempotency(req.params.id, idempotencyKey);
      if (existing) {
        res.status(existing.job.status === 'succeeded' ? 200 : 202).json(existing);
        return;
      }
      res.status(404).json({ error: '组织不存在' });
      return;
    }
    try {
      await recordGovernanceIntent(opts.governanceAuditStore, req.user!, {
        action: 'tenant.delete.schedule', targetType: 'tenant', targetId: tenant.id,
        targetTenantId: tenant.id, purpose: 'platform_governance', reason: 'confirmed_hard_delete',
        beforeDigest: governanceDigest({ id: tenant.id, name: tenant.name, disabled: tenant.disabled }),
        metadata: { idempotencyKey },
      });
      const receipt = await opts.tenantDeletionExecutor.execute({
        tenantId: tenant.id, idempotencyKey, requestedBy: req.user!.sub,
        reasonCode: 'confirmed_hard_delete',
      });
      auditLog(req, 'tenant_deleted', `${tenant.id} job=${receipt.job.jobId} status=${receipt.job.status}`);
      res.status(receipt.job.status === 'succeeded' ? 200 : 202).json(receipt);
    } catch (err) {
      if (err instanceof GovernanceAuditUnavailableError) {
        res.status(503).json({ code: err.code, error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('CHANGE_JOB_TARGET_BUSY')) {
        res.status(409).json({ code: 'CHANGE_JOB_TARGET_BUSY', error: '该组织已有活动删除任务' });
        return;
      }
      apiLogger.error(`创建组织删除任务失败（tenant=${tenant.id}）: ${message}`);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
