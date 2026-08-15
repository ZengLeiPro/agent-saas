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
  reason: z.string().min(3).max(500),
};
const previewSchema = z.object(mutationShape).strict();
const commitSchema = z.object({
  ...mutationShape,
  previewId: z.string().regex(/^tlpv1\.[a-f0-9]{64}$/),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

type TenantLifecycleRecord = { id: string; disabled?: boolean; updatedAt: string };
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

export function registerGovernanceTenantLifecycleRoutes(options: {
  router: Router;
  secret: string;
  previewTtlMs: number;
  now: () => Date;
  personaFor: (req: Request) => 'platform_admin' | 'org_admin' | 'member' | undefined;
  createTenant?: (input: { id: string; name: string; createdBy: string }) => Promise<CreatedTenantRecord>;
  getTenant?: (tenantId: string) => TenantLifecycleRecord | undefined;
  setTenantDisabled?: (
    tenantId: string,
    disabled: boolean,
    actorUserId: string,
  ) => Promise<TenantLifecycleRecord>;
  dependencyImpact?: (tenantId: string) => Promise<{
    affectedResources: Array<{ type: string; id: string; version: number }>; blockers: string[];
  }>;
}): void {
  const { router } = options;

  router.post('/tenants', async (req, res) => {
    if (options.personaFor(req) !== 'platform_admin') {
      return res.status(403).json({ error: '仅平台管理员可以创建组织', code: 'PLATFORM_ADMIN_REQUIRED' });
    }
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]!.message, code: 'INVALID_TENANT_INPUT' });
    }
    if (!options.createTenant) {
      return res.status(503).json({ error: '组织创建服务暂不可用，请稍后重试', code: 'TENANT_CREATE_UNAVAILABLE' });
    }
    try {
      const tenant = await options.createTenant({
        ...parsed.data,
        createdBy: req.user!.sub,
      });
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
    const tenant = options.getTenant(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const status = tenant.disabled ? 'suspended' : 'active';
    return res.json({
      tenantId: tenant.id, status, updatedAt: tenant.updatedAt,
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
    const tenant = options.getTenant(tenantId);
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
    const dependencyImpact = await options.dependencyImpact(tenantId).catch(() => null);
    if (!dependencyImpact) return res.status(503).json({ error: 'Dependency impact authority unavailable', code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE' });
    const baselineDigest = governanceDigest({ tenantId, status: currentStatus, updatedAt: tenant.updatedAt });
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
    const tenant = options.getTenant(tenantId);
    const status = tenant?.disabled ? 'suspended' : 'active';
    if (!tenant || governanceDigest({ tenantId, status, updatedAt: tenant.updatedAt }) !== parsed.data.baselineDigest) {
      return res.status(409).json({ error: 'Tenant lifecycle baseline changed', code: 'TENANT_LIFECYCLE_BASELINE_CONFLICT' });
    }
    try {
      const updated = await options.setTenantDisabled(tenantId, parsed.data.action === 'suspend', req.user!.sub);
      return res.json({
        tenantId, status: updated.disabled ? 'suspended' : 'active', updatedAt: updated.updatedAt,
        changeId: res.locals.governanceChangeId, effectiveAt: updated.updatedAt,
      });
    } catch (error) {
      return res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
