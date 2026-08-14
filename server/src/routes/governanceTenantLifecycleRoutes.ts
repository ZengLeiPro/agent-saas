import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Router } from 'express';
import { z } from 'zod';

import { governanceDigest } from '../data/governance-audit/index.js';
import { PLATFORM_TENANT_ID } from '../data/tenants/types.js';

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

type TenantLifecycleRecord = { id: string; name?: string; disabled?: boolean; updatedAt: string };

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
  getTenant?: (tenantId: string) => TenantLifecycleRecord | undefined;
  setTenantDisabled?: (
    tenantId: string,
    disabled: boolean,
    actorUserId: string,
    expectedUpdatedAt: string,
  ) => Promise<TenantLifecycleRecord>;
  dependencyImpact?: (tenantId: string, action: 'suspend' | 'resume') => Promise<{
    affectedResources: Array<{ type: string; id: string; version: number }>; blockers: string[];
  }>;
}): void {
  const { router } = options;
  const commitsInFlight = new Set<string>();
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
      const tenant = options.getTenant(tenantId);
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
      try {
        const updated = await options.setTenantDisabled(
          tenantId,
          parsed.data.action === 'suspend',
          req.user!.sub,
          tenant.updatedAt,
        );
        return res.json({
          tenantId, status: updated.disabled ? 'suspended' : 'active', updatedAt: updated.updatedAt,
          changeId: res.locals.governanceChangeId, effectiveAt: updated.updatedAt,
        });
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code)
          : undefined;
        return res.status(409).json({
          error: error instanceof Error ? error.message : String(error),
          ...(code ? { code } : {}),
        });
      }
    } finally {
      commitsInFlight.delete(tenantId);
    }
  });
}
