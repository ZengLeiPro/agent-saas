import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Router } from 'express';
import { z } from 'zod';

import { governanceDigest } from '../data/governance-audit/index.js';
import { PLATFORM_TENANT_ID, TENANT_SLUG_PATTERN } from '../data/tenants/types.js';

const createTenantSchema = z.object({
  id: z.string().regex(
    TENANT_SLUG_PATTERN,
    'slug 必须以小写字母开头，可含小写字母/数字/连字符，长度 2-31',
  ),
  name: z.string().trim().min(1, '组织名称不能为空').max(100, '组织名称不超过 100 字符'),
}).strict();

const mutationShape = {
  action: z.enum(['suspend', 'resume']),
  reason: z.string().trim().min(3).max(500),
};
const previewSchema = z.object(mutationShape).strict();
const commitSchema = z.object({
  ...mutationShape,
  previewId: z.string().regex(/^tlpv1\.[a-f0-9]{64}$/),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

type TenantLifecycleRecord = { id: string; name?: string; disabled?: boolean; updatedAt: string };
type CreatedTenantRecord = TenantLifecycleRecord & {
  name: string;
  createdAt: string;
  createdBy: string;
};

function sign(secret: string, input: Record<string, unknown>): string {
  return createHmac('sha256', secret).update(governanceDigest(input)).digest('hex');
}

function matches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

const LIFECYCLE_CONFLICT_CODES = new Set([
  'TENANT_LIFECYCLE_BASELINE_CONFLICT',
  'TENANT_LIFECYCLE_TRANSITION_CONFLICT',
  'DEFAULT_TENANT_PROTECTED',
  'LAST_ACTIVE_TENANT_PROTECTED',
  'TENANT_NOT_FOUND',
]);

function lifecycleMutationError(error: unknown): { status: number; error: string; code: string } {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
  if (code && LIFECYCLE_CONFLICT_CODES.has(code)) {
    return { status: 409, error: error instanceof Error ? error.message : String(error), code };
  }
  if (code?.startsWith('TENANT_STORE_')) {
    return { status: 503, error: 'Tenant lifecycle storage unavailable', code };
  }
  return {
    status: 500,
    error: 'Tenant lifecycle update failed',
    code: code ?? 'TENANT_LIFECYCLE_UPDATE_FAILED',
  };
}

export function registerGovernanceTenantLifecycleRoutes(options: {
  router: Router;
  secret: string;
  previewTtlMs: number;
  now: () => Date;
  personaFor: (req: Request) => 'platform_admin' | 'org_admin' | 'member' | undefined;
  createTenant?: (input: { id: string; name: string; createdBy: string }) => Promise<CreatedTenantRecord>;
  rollbackTenantCreate?: (tenantId: string) => Promise<void>;
  getTenant?: (tenantId: string) => TenantLifecycleRecord | undefined;
  setTenantDisabled?: (
    tenantId: string,
    disabled: boolean,
    actorUserId: string,
    expectedUpdatedAt: string,
  ) => Promise<TenantLifecycleRecord>;
  onTenantLifecycleChanged?: (change: {
    tenantId: string;
    disabled: boolean;
    actorUserId: string;
    reason: string;
    updatedAt: string;
  }) => Promise<'applied' | 'pending' | void>;
  dependencyImpact?: (tenantId: string, action: 'suspend' | 'resume') => Promise<{
    affectedResources: Array<{ type: string; id: string; version: number }>; blockers: string[];
  }>;
}): void {
  const { router } = options;
  const commitsInFlight = new Set<string>();

  router.post('/tenants', async (req, res) => {
    if (options.personaFor(req) !== 'platform_admin') {
      return res.status(403).json({ error: '仅平台管理员可以创建组织', code: 'PLATFORM_ADMIN_REQUIRED' });
    }
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]!.message, code: 'INVALID_TENANT_INPUT' });
    }
    if (!options.createTenant || !options.rollbackTenantCreate) {
      return res.status(503).json({ error: '组织创建服务暂不可用，请稍后重试', code: 'TENANT_CREATE_UNAVAILABLE' });
    }
    try {
      const tenant = await options.createTenant({
        ...parsed.data,
        createdBy: req.user!.sub,
      });
      res.locals.governanceCompensation = {
        rollback: () => options.rollbackTenantCreate!(tenant.id),
        failureBody: {
          error: '创建组织失败，未保存任何组织信息，请稍后重试；如问题持续，请联系平台运维人员',
          code: 'TENANT_CREATE_FAILED',
        },
        rollbackFailureBody: {
          error: '创建组织失败且自动清理未完成，请勿重复提交，并联系平台运维人员处理',
          code: 'TENANT_CREATE_ROLLBACK_FAILED',
        },
      };
      return res.status(201).json({
        tenant: {
          id: tenant.id,
          name: tenant.name,
          createdAt: tenant.createdAt,
          createdBy: tenant.createdBy,
          updatedAt: tenant.updatedAt,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('already exists')) {
        return res.status(409).json({ error: '该组织 slug 已存在，请更换后重试', code: 'TENANT_ALREADY_EXISTS' });
      }
      if (message.includes('Invalid tenant id') || message.includes('cannot be empty')) {
        return res.status(400).json({ error: '组织信息格式无效，请检查后重试', code: 'INVALID_TENANT_INPUT' });
      }
      return res.status(500).json({
        error: '创建组织失败，未保存任何组织信息，请稍后重试；如问题持续，请联系平台运维人员',
        code: 'TENANT_CREATE_FAILED',
      });
    }
  });

  router.get('/tenant-lifecycle', async (req, res) => {
    if (options.personaFor(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    if (!tenantId || !options.getTenant) {
      return res.status(503).json({ error: 'Tenant lifecycle authority unavailable', code: 'TENANT_LIFECYCLE_AUTHORITY_UNAVAILABLE' });
    }
    let tenant: TenantLifecycleRecord | undefined;
    try {
      tenant = options.getTenant(tenantId);
    } catch (error) {
      const mapped = lifecycleMutationError(error);
      return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
    }
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const status = tenant.disabled ? 'suspended' : 'active';
    return res.json({
      tenantId: tenant.id, tenantName: tenant.name ?? tenant.id, status, updatedAt: tenant.updatedAt,
      allowedActions: tenant.id === PLATFORM_TENANT_ID ? [] : [{
        id: status === 'active' ? 'suspend' : 'resume',
        label: status === 'active' ? '暂停组织' : '恢复组织',
        action: status === 'active' ? 'suspend' : 'resume',
        requiresReason: true,
      }],
    });
  });

  router.post('/tenant-lifecycle/preview', async (req, res) => {
    if (options.personaFor(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = previewSchema.safeParse(req.body);
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    if (!parsed.success || !tenantId) return res.status(400).json({ error: 'Invalid request' });
    if (!options.getTenant) return res.status(503).json({ error: 'Tenant lifecycle authority unavailable' });
    let tenant: TenantLifecycleRecord | undefined;
    try {
      tenant = options.getTenant(tenantId);
    } catch (error) {
      const mapped = lifecycleMutationError(error);
      return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
    }
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (tenantId === PLATFORM_TENANT_ID) {
      return res.status(409).json({ error: 'Platform tenant lifecycle is protected', code: 'DEFAULT_TENANT_PROTECTED' });
    }
    const currentStatus = tenant.disabled ? 'suspended' : 'active';
    const expectedStatus = parsed.data.action === 'suspend' ? 'active' : 'suspended';
    if (currentStatus !== expectedStatus) {
      return res.status(409).json({ error: 'Tenant lifecycle transition conflict', code: 'TENANT_LIFECYCLE_TRANSITION_CONFLICT' });
    }
    if (!options.dependencyImpact) return res.status(503).json({ error: 'Dependency impact authority unavailable', code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE' });
    const dependencyImpact = await options.dependencyImpact(tenantId, parsed.data.action).catch(() => null);
    if (!dependencyImpact) return res.status(503).json({ error: 'Dependency impact authority unavailable', code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE' });
    const baselineDigest = governanceDigest({
      tenantId, status: currentStatus, updatedAt: tenant.updatedAt,
      affectedResources: dependencyImpact.affectedResources, blockers: dependencyImpact.blockers,
    });
    const expiresAt = new Date(options.now().getTime() + options.previewTtlMs).toISOString();
    const signature = {
      version: 1, actorUserId: req.user!.sub, tenantId,
      action: parsed.data.action, reason: parsed.data.reason, baselineDigest, expiresAt,
    };
    return res.json({
      previewId: `tlpv1.${sign(options.secret, signature)}`,
      baselineDigest, expiresAt,
      impact: {
        tenantId, from: currentStatus, to: parsed.data.action === 'suspend' ? 'suspended' : 'active',
        affectedResources: dependencyImpact.affectedResources,
        blockers: dependencyImpact.blockers, reversible: true, effectiveMode: 'immediate',
      },
      changeId: res.locals.governanceChangeId,
    });
  });

  router.post('/tenant-lifecycle', async (req, res) => {
    if (options.personaFor(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = commitSchema.safeParse(req.body);
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    if (!parsed.success || !tenantId) return res.status(400).json({ error: 'Invalid request' });
    if (!options.getTenant || !options.setTenantDisabled) return res.status(503).json({ error: 'Tenant lifecycle authority unavailable' });
    if (!options.dependencyImpact) return res.status(503).json({ error: 'Dependency impact authority unavailable', code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE' });
    if (Date.parse(parsed.data.expiresAt) <= options.now().getTime()) {
      return res.status(409).json({ error: 'Tenant lifecycle preview expired', code: 'TENANT_LIFECYCLE_PREVIEW_EXPIRED' });
    }
    const expectedPreviewId = `tlpv1.${sign(options.secret, {
      version: 1, actorUserId: req.user!.sub, tenantId,
      action: parsed.data.action, reason: parsed.data.reason,
      baselineDigest: parsed.data.baselineDigest, expiresAt: parsed.data.expiresAt,
    })}`;
    if (!matches(parsed.data.previewId, expectedPreviewId)) {
      return res.status(409).json({ error: 'Tenant lifecycle preview invalid', code: 'TENANT_LIFECYCLE_PREVIEW_INVALID' });
    }
    if (commitsInFlight.has(tenantId)) {
      return res.status(409).json({
        error: 'Tenant lifecycle transition already in progress',
        code: 'TENANT_LIFECYCLE_TRANSITION_IN_PROGRESS',
      });
    }
    commitsInFlight.add(tenantId);
    try {
      let tenant: TenantLifecycleRecord | undefined;
      try {
        tenant = options.getTenant(tenantId);
      } catch (error) {
        const mapped = lifecycleMutationError(error);
        return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
      }
      const status = tenant?.disabled ? 'suspended' : 'active';
      if (!tenant) {
        return res.status(409).json({ error: 'Tenant lifecycle baseline changed', code: 'TENANT_LIFECYCLE_BASELINE_CONFLICT' });
      }
      const dependencyImpact = await options.dependencyImpact(tenantId, parsed.data.action).catch(() => null);
      if (!dependencyImpact) return res.status(503).json({ error: 'Dependency impact authority unavailable', code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE' });
      const currentBaselineDigest = governanceDigest({
        tenantId, status, updatedAt: tenant.updatedAt,
        affectedResources: dependencyImpact.affectedResources, blockers: dependencyImpact.blockers,
      });
      if (currentBaselineDigest !== parsed.data.baselineDigest) {
        return res.status(409).json({ error: 'Tenant lifecycle impact or baseline changed', code: 'TENANT_LIFECYCLE_BASELINE_CONFLICT' });
      }
      if (dependencyImpact.blockers.length > 0) {
        return res.status(409).json({
          error: `Tenant lifecycle transition blocked: ${dependencyImpact.blockers.join('; ')}`,
          code: 'TENANT_LIFECYCLE_BLOCKED', blockers: dependencyImpact.blockers,
        });
      }
      const disabled = parsed.data.action === 'suspend';
      let updated: TenantLifecycleRecord;
      try {
        updated = await options.setTenantDisabled(
          tenantId,
          disabled,
          req.user!.sub,
          tenant.updatedAt,
        );
      } catch (error) {
        const mapped = lifecycleMutationError(error);
        return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
      }

      let propagationStatus: 'applied' | 'pending' = 'applied';
      try {
        const result = await options.onTenantLifecycleChanged?.({
          tenantId,
          disabled,
          actorUserId: req.user!.sub,
          reason: parsed.data.reason,
          updatedAt: updated.updatedAt,
        });
        if (result === 'pending') propagationStatus = 'pending';
      } catch {
        propagationStatus = 'pending';
      }
      const response = {
        tenantId, status: updated.disabled ? 'suspended' : 'active', updatedAt: updated.updatedAt,
        changeId: res.locals.governanceChangeId, effectiveAt: updated.updatedAt, propagationStatus,
        ...(propagationStatus === 'pending' ? {
          warning: 'Tenant state persisted; cross-instance effects are retrying',
          code: 'TENANT_LIFECYCLE_PROPAGATION_PENDING',
        } : {}),
      };
      return propagationStatus === 'pending' ? res.status(202).json(response) : res.json(response);
    } finally {
      commitsInFlight.delete(tenantId);
    }
  });
}
