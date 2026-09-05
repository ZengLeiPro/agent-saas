import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { hasPlatformCapability } from '../auth/platformGovernance.js';
import { isPlatformAdmin, requireAdmin, requirePlatformAdmin } from '../auth/middleware.js';
import {
  SkillPresentationConflictError,
  type SkillPresentationKey,
  type SkillPresentationRecord,
  type SkillPresentationStore,
  type SkillPresentationView,
} from '../data/skillPresentations/index.js';
import {
  GovernanceAuditUnavailableError,
  governanceDigest,
  recordGovernanceIntent,
  recordGovernanceOutcome,
  type GovernanceAuditStore,
} from '../data/governance-audit/index.js';
import { safeName } from './skillRouteValidation.js';

const bodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    summary: z.string().trim().min(1).max(240),
    expectedRevision: z.number().int().min(0),
  })
  .strict();

const revisionSchema = z.coerce.number().int().min(1);

function view(
  record: SkillPresentationRecord,
  source: SkillPresentationView['source'],
): SkillPresentationView {
  return {
    displayName: record.displayName,
    summary: record.summary,
    locale: 'zh-CN',
    source,
    revision: record.revision,
  };
}

function canManageTenant(req: Request, res: Response, tenantId: string): boolean {
  if (isPlatformAdmin(req.user)) {
    if (hasPlatformCapability(req.user, 'skill.tenant.manage')) return true;
    res
      .status(403)
      .json({ error: '当前平台管理员无组织技能管理权限', code: 'PLATFORM_CAPABILITY_REQUIRED' });
    return false;
  }
  if (req.user?.role === 'admin' && req.user.tenantId === tenantId) return true;
  res
    .status(403)
    .json({ error: '不能管理其他组织的技能展示信息', code: 'SKILL_TENANT_SCOPE_DENIED' });
  return false;
}

function mutationError(res: Response, error: unknown): void {
  if (error instanceof SkillPresentationConflictError) {
    res.status(409).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: '更新技能展示信息失败', code: 'SKILL_PRESENTATION_UPDATE_FAILED' });
}

function auditUnavailable(res: Response, error: unknown): boolean {
  if (!(error instanceof GovernanceAuditUnavailableError)) return false;
  res.status(503).json({ error: error.message, code: error.code });
  return true;
}

export function registerSkillPresentationRoutes(
  router: Router,
  deps: {
    store?: SkillPresentationStore;
    audit?: GovernanceAuditStore;
    hasPoolSkill(skillId: string): Promise<boolean>;
    canManagePoolSkill(tenantId: string, skillId: string): Promise<boolean>;
    hasTenantSkill(tenantId: string, skillId: string): Promise<boolean>;
  },
): void {
  async function upsertPresentation(
    req: Request,
    res: Response,
    key: SkillPresentationKey,
    source: Exclude<SkillPresentationView['source'], 'fallback'>,
    targetTenantId?: string,
  ) {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: '技能展示信息无效', details: parsed.error.format() });
    if (!deps.store)
      return res
        .status(503)
        .json({ error: '技能展示信息服务暂不可用', code: 'SKILL_PRESENTATION_UNAVAILABLE' });
    const previous = await deps.store.getExact(key);
    const targetId = [
      key.resourceScope,
      key.resourceTenantId,
      key.skillId,
      key.audienceTenantId || 'global',
    ].join(':');
    let intent;
    try {
      intent = await recordGovernanceIntent(deps.audit, req.user!, {
        action: 'skill.presentation.update',
        targetType: 'skill_presentation',
        targetId,
        ...(targetTenantId ? { targetTenantId } : {}),
        purpose: '更新技能在能力中心的展示名称和简介',
        beforeDigest: governanceDigest(previous),
        metadata: { locale: key.locale, source },
      });
    } catch (error) {
      if (auditUnavailable(res, error)) return;
      throw error;
    }
    let updated: SkillPresentationRecord;
    try {
      updated = await deps.store.upsert({ ...key, ...parsed.data, updatedBy: req.user!.sub });
    } catch (error) {
      await recordGovernanceOutcome(deps.audit!, intent, 'failed', {
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      mutationError(res, error);
      return;
    }
    try {
      await recordGovernanceOutcome(deps.audit!, intent, 'succeeded', {
        afterDigest: governanceDigest(updated),
      });
    } catch {
      return res.status(500).json({
        error: '展示信息已更新，但治理审计结果写入失败，请立即人工核对',
        code: 'GOVERNANCE_AUDIT_OUTCOME_FAILED',
        changed: true,
        intentAuditId: intent.auditId,
      });
    }
    return res.json({ ok: true, presentation: view(updated, source) });
  }

  router.put('/pool/:skillId/presentation', requirePlatformAdmin, async (req, res) => {
    if (!isPlatformAdmin(req.user) || !hasPlatformCapability(req.user, 'skill.platform.manage')) {
      return res
        .status(403)
        .json({ error: '当前平台管理员无平台技能管理权限', code: 'PLATFORM_CAPABILITY_REQUIRED' });
    }
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });
    if (!(await deps.hasPoolSkill(skillId)))
      return res.status(404).json({ error: `技能“${skillId}”不存在` });
    return upsertPresentation(
      req,
      res,
      {
        resourceScope: 'platform',
        resourceTenantId: '',
        skillId,
        audienceTenantId: '',
        locale: 'zh-CN',
      },
      'platform_default',
    );
  });

  router.put('/tenants/:tenantId/pool/:skillId/presentation', requireAdmin, async (req, res) => {
    const tenantId = safeName(req.params.tenantId);
    const skillId = safeName(req.params.skillId);
    if (!tenantId || !skillId)
      return res.status(400).json({ error: 'Invalid tenantId or skillId' });
    if (!canManageTenant(req, res, tenantId)) return;
    if (!(await deps.canManagePoolSkill(tenantId, skillId)))
      return res.status(404).json({ error: `技能“${skillId}”不存在` });
    return upsertPresentation(
      req,
      res,
      {
        resourceScope: 'platform',
        resourceTenantId: '',
        skillId,
        audienceTenantId: tenantId,
        locale: 'zh-CN',
      },
      'organization_override',
      tenantId,
    );
  });

  router.delete('/tenants/:tenantId/pool/:skillId/presentation', requireAdmin, async (req, res) => {
    const tenantId = safeName(req.params.tenantId);
    const skillId = safeName(req.params.skillId);
    const revision = revisionSchema.safeParse(req.query.expectedRevision);
    if (!tenantId || !skillId || !revision.success)
      return res.status(400).json({ error: 'Invalid tenantId, skillId or expectedRevision' });
    if (!canManageTenant(req, res, tenantId)) return;
    if (!deps.store)
      return res
        .status(503)
        .json({ error: '技能展示信息服务暂不可用', code: 'SKILL_PRESENTATION_UNAVAILABLE' });
    const key: SkillPresentationKey = {
      resourceScope: 'platform',
      resourceTenantId: '',
      skillId,
      audienceTenantId: tenantId,
      locale: 'zh-CN',
    };
    const previous = await deps.store.getExact(key);
    if (!previous) return res.status(404).json({ error: '当前组织未设置自定义展示信息' });
    let intent;
    try {
      intent = await recordGovernanceIntent(deps.audit, req.user!, {
        action: 'skill.presentation.restore_default',
        targetType: 'skill_presentation',
        targetId: `platform::${skillId}:${tenantId}`,
        targetTenantId: tenantId,
        purpose: '恢复平台技能的默认展示信息',
        beforeDigest: governanceDigest(previous),
        metadata: { locale: key.locale },
      });
    } catch (error) {
      if (auditUnavailable(res, error)) return;
      throw error;
    }
    try {
      await deps.store.delete(key, revision.data);
    } catch (error) {
      await recordGovernanceOutcome(deps.audit!, intent, 'failed', {
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      mutationError(res, error);
      return;
    }
    try {
      await recordGovernanceOutcome(deps.audit!, intent, 'succeeded', {
        afterDigest: governanceDigest(null),
      });
    } catch {
      return res.status(500).json({
        error: '平台默认已恢复，但治理审计结果写入失败，请立即人工核对',
        code: 'GOVERNANCE_AUDIT_OUTCOME_FAILED',
        changed: true,
        intentAuditId: intent.auditId,
      });
    }
    return res.json({ ok: true });
  });

  router.put('/tenants/:tenantId/skills/:skillId/presentation', requireAdmin, async (req, res) => {
    const tenantId = safeName(req.params.tenantId);
    const skillId = safeName(req.params.skillId);
    if (!tenantId || !skillId)
      return res.status(400).json({ error: 'Invalid tenantId or skillId' });
    if (!canManageTenant(req, res, tenantId)) return;
    if (!(await deps.hasTenantSkill(tenantId, skillId)))
      return res.status(404).json({ error: `组织技能“${skillId}”不存在` });
    return upsertPresentation(
      req,
      res,
      {
        resourceScope: 'tenant',
        resourceTenantId: tenantId,
        skillId,
        audienceTenantId: '',
        locale: 'zh-CN',
      },
      'organization_default',
      tenantId,
    );
  });
}
