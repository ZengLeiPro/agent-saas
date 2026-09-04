import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Router } from 'express';
import { z } from 'zod';

import type { PgEntitlementStore } from '../data/entitlements/index.js';
import { getTenantPolicyDefinition } from '../data/entitlements/policyCatalog.js';
import {
  ENTITLEMENT_RESOURCE_TYPES,
  isOrganizationEditableTenantPolicyKey,
  type EntitlementResourceType,
} from '../data/entitlements/types.js';
import { PLATFORM_TENANT_ID } from '../data/tenants/types.js';
import { governanceDigest } from '../data/governance-audit/index.js';
import type { GovernanceProjectionReconciler, PgGovernanceProjectionOutboxStore } from '../data/governanceProjection/index.js';

const entitlementShape = {
  expectedVersion: z.number().int().positive(),
  status: z.enum(['trial', 'active', 'suspended', 'expired']).optional(),
  effectiveFrom: z.string().datetime().nullable().optional(),
  effectiveTo: z.string().datetime().nullable().optional(),
  limits: z.record(z.string(), z.number().finite().nonnegative()).optional(),
  reason: z.string().min(3).max(500),
};
const entitlementPreviewSchema = z.object(entitlementShape).strict();
const entitlementCommitSchema = z.object({
  ...entitlementShape,
  previewId: z.string().regex(/^gpv1\.[a-f0-9]{64}$/),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
const scopeShape = {
  expectedVersion: z.number().int().positive(),
  mode: z.enum(['all', 'selected']),
  resourceIds: z.array(z.string().min(1).max(200)).max(1000),
};
const scopePreviewSchema = z.object(scopeShape).strict();
const scopeCommitSchema = z.object({
  ...scopeShape,
  previewId: z.string().regex(/^gpv1\.[a-f0-9]{64}$/),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
type Persona = 'platform_admin' | 'org_admin' | 'member';

function sign(secret: string, input: Record<string, unknown>): string {
  return createHmac('sha256', secret).update(governanceDigest(input)).digest('hex');
}

function matches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function containsNewCatalogMissingResource(
  requestedIds: readonly string[],
  currentIds: readonly string[],
  catalogIds: readonly string[],
): boolean {
  const baseline = new Set(currentIds);
  const catalog = new Set(catalogIds);
  return requestedIds.some(id => !catalog.has(id) && !baseline.has(id));
}

export function registerGovernanceEntitlementRoutes(options: {
  router: Router;
  entitlements: PgEntitlementStore;
  projectionOutbox?: PgGovernanceProjectionOutboxStore;
  projectionReconciler?: GovernanceProjectionReconciler;
  secret: string;
  previewTtlMs: number;
  now: () => Date;
  personaFor: (req: Request) => Persona | undefined;
  tenantFor: (req: Request, requested?: string) => string | null;
  resolveResource?: (
    resourceType: EntitlementResourceType,
    resourceId: string,
  ) => Promise<{ status: 'valid'; version: number } | { status: 'not_found' | 'unavailable' }>;
  listResources?: (
    resourceType: EntitlementResourceType,
  ) => Promise<{ status: 'valid'; items: Array<{ resourceId: string; version: number }> } | { status: 'unavailable' }>;
  dependencyImpact?: (input: { tenantId: string; kind: 'entitlement' | 'scope'; resourceType?: EntitlementResourceType }) => Promise<{
    affectedResources: Array<{ type: string; id: string; version: number }>; blockers: string[];
  }>;
}): void {
  const { router } = options;
  const catalogSnapshot = async (
    resourceType: EntitlementResourceType,
    mode: 'all' | 'selected',
    resourceIds: string[],
    currentResourceIds: string[],
  ) => {
    const requestedIds = [...new Set(resourceIds)].sort();
    const baselineIds = new Set(currentResourceIds);
    if (options.listResources) {
      const catalog = await options.listResources(resourceType);
      if (catalog.status !== 'valid') return { status: 'unavailable' as const, items: [] };
      const items = [...catalog.items].sort((a, b) => a.resourceId.localeCompare(b.resourceId));
      if (mode === 'selected' && containsNewCatalogMissingResource(
        requestedIds, currentResourceIds, items.map(item => item.resourceId),
      )) {
        return { status: 'not_found' as const, items: [] };
      }
      return { status: 'valid' as const, items };
    }
    if (mode === 'all') return { status: 'unavailable' as const, items: [] };
    if (!options.resolveResource) return { status: 'unavailable' as const, items: [] };
    const items: Array<{ resourceId: string; version: number }> = [];
    for (const resourceId of requestedIds) {
      const resolved = await options.resolveResource(resourceType, resourceId);
      if (resolved.status !== 'valid') {
        if (resolved.status === 'unavailable') return { status: 'unavailable' as const, items: [] };
        if (baselineIds.has(resourceId)) continue;
        return { status: 'not_found' as const, items: [] };
      }
      items.push({ resourceId, version: resolved.version });
    }
    return { status: 'valid' as const, items };
  };
  router.get('/entitlements', async (req, res) => {
    const persona = options.personaFor(req);
    if (persona !== 'platform_admin' && persona !== 'org_admin') return res.status(403).json({ error: 'Admin required' });
    const tenantId = options.tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (tenantId === PLATFORM_TENANT_ID) {
      return res.status(409).json({
        error: 'Platform tenant does not use organization entitlements',
        code: 'PLATFORM_TENANT_GOVERNANCE_FORBIDDEN',
      });
    }
    let entitlement: Awaited<ReturnType<PgEntitlementStore['getEntitlementSet']>>;
    let scopes: Awaited<ReturnType<PgEntitlementStore['listResourceScopes']>>;
    let policies: Awaited<ReturnType<PgEntitlementStore['getPolicies']>>;
    try {
      [entitlement, scopes, policies] = await Promise.all([
        options.entitlements.getEntitlementSet(tenantId),
        options.entitlements.listResourceScopes(tenantId),
        options.entitlements.getPolicies(tenantId),
      ]);
    } catch {
      return res.status(503).json({
        error: 'Entitlement authority unavailable',
        code: 'ENTITLEMENT_AUTHORITY_UNAVAILABLE',
      });
    }
    const entitlementAction = entitlement?.status === 'suspended'
      ? { id: 'activate', label: '恢复权益', change: { status: 'active' }, requiresReason: true }
      : entitlement && ['active', 'trial'].includes(entitlement.status)
        ? { id: 'suspend', label: '暂停权益', change: { status: 'suspended' }, requiresReason: true }
        : null;
    const allowedActions = persona === 'platform_admin' && entitlementAction ? [entitlementAction] : [];
    const scopedActions = scopes.map(scope => ({
      ...scope,
      allowedActions: ['platform_admin', 'org_admin'].includes(persona ?? '')
        ? [{ id: 'edit_scope', label: '从目录编辑', resourceType: scope.resourceType }]
        : [],
    }));
    const policyActions = policies.map(policy => ({
      ...policy,
      definition: getTenantPolicyDefinition(policy.policyKey),
      allowedActions: (persona === 'org_admin' || persona === 'platform_admin')
        && typeof policy.value === 'boolean'
        && isOrganizationEditableTenantPolicyKey(policy.policyKey)
        ? [{ id: 'edit_policy', label: '编辑组织策略', resourceType: 'tenant_policy' }]
        : [],
    }));
    return res.json({ entitlement, scopes: scopedActions, policies: policyActions, allowedActions });
  });

  router.post('/entitlements/preview', async (req, res) => {
    if (options.personaFor(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = entitlementPreviewSchema.safeParse(req.body);
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    if (!parsed.success || !tenantId) return res.status(400).json({ error: 'Invalid request' });
    const current = await options.entitlements.getEntitlementSet(tenantId);
    if (!current || current.version !== parsed.data.expectedVersion) {
      return res.status(409).json({ error: 'Entitlement baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    }
    if (!options.dependencyImpact) return res.status(503).json({ error: 'Dependency impact authority unavailable', code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE' });
    const dependencyImpact = await options.dependencyImpact({ tenantId, kind: 'entitlement' }).catch(() => null);
    if (!dependencyImpact) return res.status(503).json({ error: 'Dependency impact authority unavailable', code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE' });
    const baselineDigest = governanceDigest(current);
    const expiresAt = new Date(options.now().getTime() + options.previewTtlMs).toISOString();
    const signature = {
      version: 1, kind: 'entitlement', actorUserId: req.user!.sub, actorTenantId: req.user!.tenantId,
      actorPersona: options.personaFor(req), tenantId,
      baselineDigest, expiresAt, changeDigest: governanceDigest(parsed.data),
    };
    return res.json({
      previewId: `gpv1.${sign(options.secret, signature)}`,
      baselineDigest, expiresAt,
      impact: {
        tenantId, currentVersion: current.version, nextVersion: current.version + 1,
        fromStatus: current.status, toStatus: parsed.data.status ?? current.status,
        affectedResources: dependencyImpact.affectedResources,
        blockers: dependencyImpact.blockers, reversible: true,
        effectiveMode: options.projectionOutbox ? 'source_immediate_projection_pending' : 'source_immediate',
      },
      changeId: res.locals.governanceChangeId,
    });
  });

  router.patch('/entitlements', async (req, res) => {
    if (options.personaFor(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = entitlementCommitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = options.tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (!options.dependencyImpact) return res.status(503).json({ error: 'Dependency impact authority unavailable', code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE' });
    const { previewId, baselineDigest, expiresAt, ...mutation } = parsed.data;
    if (Date.parse(expiresAt) <= options.now().getTime()) {
      return res.status(409).json({ error: 'Governance preview expired', code: 'GOVERNANCE_PREVIEW_EXPIRED' });
    }
    const expectedPreviewId = `gpv1.${sign(options.secret, {
      version: 1, kind: 'entitlement', actorUserId: req.user!.sub, actorTenantId: req.user!.tenantId,
      actorPersona: options.personaFor(req), tenantId,
      baselineDigest, expiresAt, changeDigest: governanceDigest(mutation),
    })}`;
    const current = await options.entitlements.getEntitlementSet(tenantId);
    if (!matches(previewId, expectedPreviewId)) {
      return res.status(409).json({ error: 'Governance preview invalid', code: 'GOVERNANCE_PREVIEW_INVALID' });
    }
    if (!current || current.version !== mutation.expectedVersion || governanceDigest(current) !== baselineDigest) {
      return res.status(409).json({ error: 'Governance baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    }
    try {
      const { reason, ...patch } = mutation;
      const entitlement = await options.entitlements.updateEntitlementSet(tenantId, {
        ...patch, updatedBy: req.user!.sub, updateReason: reason,
      });
      let projectionId: string | undefined;
      if (options.projectionOutbox) {
        try {
          const projection = await options.projectionOutbox.enqueue({
            tenantId, projector: 'tenant_settings',
            idempotencyKey: `entitlement:${entitlement.version}`,
            payload: { tenantId, source: 'entitlement', version: entitlement.version },
          });
          projectionId = projection.outboxId;
          void options.projectionReconciler?.reconcileOne();
        } catch {
          return res.status(500).json({
            error: 'Entitlement 已更新，但兼容投影未能持久化',
            code: 'GOVERNANCE_PROJECTION_NOT_DURABLE', changed: true,
            changeId: res.locals.governanceChangeId,
          });
        }
      }
      return res.json({
        ...entitlement,
        changeId: res.locals.governanceChangeId,
        effectiveAt: entitlement.updatedAt,
        projectionStatus: options.projectionOutbox ? 'pending' : 'not_configured',
        compatibilityProjection: options.projectionOutbox ? 'applied_with_projection_pending' : 'not_configured',
        ...(projectionId ? { projectionId } : {}),
      });
    } catch (error) {
      return res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/entitlement-scopes/:resourceType/preview', async (req, res) => {
    const persona = options.personaFor(req);
    if (persona !== 'platform_admin' && persona !== 'org_admin') return res.status(403).json({ error: 'Admin required' });
    const parsed = scopePreviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
    const tenantId = options.tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const resourceType = req.params.resourceType as EntitlementResourceType;
    if (!(ENTITLEMENT_RESOURCE_TYPES as readonly string[]).includes(resourceType)) {
      return res.status(400).json({ error: 'Unsupported resourceType' });
    }
    const current = (await options.entitlements.listResourceScopes(tenantId))
      .find(scope => scope.resourceType === resourceType);
    if (!current || current.version !== parsed.data.expectedVersion) {
      return res.status(409).json({ error: 'Scope baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    }
    const catalog = await catalogSnapshot(
      resourceType, parsed.data.mode, parsed.data.resourceIds, current.resourceIds,
    );
    if (catalog.status === 'unavailable') return res.status(503).json({
      error: 'Resource catalog authority unavailable', code: 'RESOURCE_CATALOG_UNAVAILABLE',
    });
    if (catalog.status === 'not_found') return res.status(409).json({ error: 'Selected resource is not assignable', code: 'ENTITLEMENT_RESOURCE_NOT_ASSIGNABLE' });
    if (!options.dependencyImpact) return res.status(503).json({ error: 'Dependency impact authority unavailable', code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE' });
    const dependencyImpact = await options.dependencyImpact({ tenantId, kind: 'scope', resourceType }).catch(() => null);
    if (!dependencyImpact) return res.status(503).json({ error: 'Dependency impact authority unavailable', code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE' });
    const baselineDigest = governanceDigest({ current, catalog: catalog.items });
    const expiresAt = new Date(options.now().getTime() + options.previewTtlMs).toISOString();
    const signature = {
      version: 1, kind: 'scope', actorUserId: req.user!.sub, actorTenantId: req.user!.tenantId,
      actorPersona: options.personaFor(req), tenantId,
      resourceType: req.params.resourceType, baselineDigest, expiresAt,
      changeDigest: governanceDigest(parsed.data),
    };
    return res.json({
      previewId: `gpv1.${sign(options.secret, signature)}`,
      baselineDigest, expiresAt,
      impact: {
        tenantId, resourceType: req.params.resourceType,
        currentVersion: current.version, nextVersion: current.version + 1,
        from: { mode: current.mode, resourceCount: current.resourceIds.length },
        to: { mode: parsed.data.mode, resourceCount: parsed.data.mode === 'all' ? catalog.items.length : parsed.data.resourceIds.length },
        affectedResources: dependencyImpact.affectedResources,
        blockers: dependencyImpact.blockers, reversible: true,
        effectiveMode: options.projectionOutbox ? 'source_immediate_projection_pending' : 'source_immediate',
      },
      changeId: res.locals.governanceChangeId,
    });
  });

  router.put('/entitlement-scopes/:resourceType', async (req, res) => {
    const persona = options.personaFor(req);
    if (persona !== 'platform_admin' && persona !== 'org_admin') return res.status(403).json({ error: 'Admin required' });
    const parsed = scopeCommitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = options.tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (!options.dependencyImpact) return res.status(503).json({ error: 'Dependency impact authority unavailable', code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE' });
    const resourceType = req.params.resourceType as EntitlementResourceType;
    if (!(ENTITLEMENT_RESOURCE_TYPES as readonly string[]).includes(resourceType)) {
      return res.status(400).json({ error: 'Unsupported resourceType' });
    }
    const { previewId, baselineDigest, expiresAt, ...mutation } = parsed.data;
    if (Date.parse(expiresAt) <= options.now().getTime()) {
      return res.status(409).json({ error: 'Governance preview expired', code: 'GOVERNANCE_PREVIEW_EXPIRED' });
    }
    const expectedPreviewId = `gpv1.${sign(options.secret, {
      version: 1, kind: 'scope', actorUserId: req.user!.sub, actorTenantId: req.user!.tenantId,
      actorPersona: options.personaFor(req), tenantId,
      resourceType: req.params.resourceType, baselineDigest, expiresAt,
      changeDigest: governanceDigest(mutation),
    })}`;
    const current = (await options.entitlements.listResourceScopes(tenantId))
      .find(scope => scope.resourceType === resourceType);
    if (!current) {
      return res.status(409).json({ error: 'Scope baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    }
    const catalog = await catalogSnapshot(
      resourceType, mutation.mode, mutation.resourceIds, current.resourceIds,
    );
    if (catalog.status === 'unavailable') return res.status(503).json({
      error: 'Resource catalog authority unavailable', code: 'RESOURCE_CATALOG_UNAVAILABLE',
    });
    if (catalog.status === 'not_found') return res.status(409).json({ error: 'Selected resource is not assignable', code: 'ENTITLEMENT_RESOURCE_NOT_ASSIGNABLE' });
    if (!matches(previewId, expectedPreviewId)) {
      return res.status(409).json({ error: 'Governance preview invalid', code: 'GOVERNANCE_PREVIEW_INVALID' });
    }
    if (current.version !== mutation.expectedVersion
      || governanceDigest({ current, catalog: catalog.items }) !== baselineDigest) {
      return res.status(409).json({ error: 'Governance baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    }
    try {
      const scope = await options.entitlements.replaceResourceScope(
        tenantId, req.params.resourceType as EntitlementResourceType,
        { ...mutation, updatedBy: req.user!.sub },
      );
      let projectionId: string | undefined;
      if (options.projectionOutbox) {
        try {
          const projection = await options.projectionOutbox.enqueue({
            tenantId, projector: 'tenant_settings',
            idempotencyKey: `scope:${scope.resourceType}:${scope.version}`,
            payload: { tenantId, source: 'scope', resourceType: scope.resourceType, version: scope.version },
          });
          projectionId = projection.outboxId;
          void options.projectionReconciler?.reconcileOne();
        } catch {
          return res.status(500).json({
            error: 'Resource Scope 已更新，但兼容投影未能持久化',
            code: 'GOVERNANCE_PROJECTION_NOT_DURABLE', changed: true,
            changeId: res.locals.governanceChangeId,
          });
        }
      }
      return res.json({
        ...scope,
        changeId: res.locals.governanceChangeId,
        effectiveAt: scope.updatedAt,
        projectionStatus: options.projectionOutbox ? 'pending' : 'not_configured',
        compatibilityProjection: options.projectionOutbox ? 'applied_with_projection_pending' : 'not_configured',
        ...(projectionId ? { projectionId } : {}),
      });
    } catch (error) {
      return res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
