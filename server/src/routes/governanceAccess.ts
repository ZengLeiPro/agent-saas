import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';

import type { PgAssignmentStore } from '../data/assignments/index.js';
import type { AssignmentResourceType } from '../data/assignments/types.js';
import type { PgEntitlementStore } from '../data/entitlements/index.js';
import type { EntitlementResourceType, TenantPolicyKey } from '../data/entitlements/types.js';
import type { GovernanceAuditStore } from '../data/governance-audit/index.js';
import type { PgMembershipStore } from '../data/memberships/index.js';
import type { PgContentAccessGrantStore } from '../data/contentAccess/index.js';
import type { GovernanceProjectionReconciler, PgGovernanceProjectionOutboxStore } from '../data/governanceProjection/index.js';

const membershipPatchSchema = z.object({
  expectedVersion: z.number().int().positive(),
  persona: z.enum(['member', 'org_admin']).optional(),
  isOwner: z.boolean().optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).strict();
const platformAdminPatchSchema = z.object({
  expectedVersion: z.number().int().positive(),
  status: z.enum(['active', 'disabled']),
}).strict();
const entitlementPatchSchema = z.object({
  expectedVersion: z.number().int().positive(),
  status: z.enum(['trial', 'active', 'suspended', 'expired']).optional(),
  effectiveFrom: z.string().datetime().nullable().optional(),
  effectiveTo: z.string().datetime().nullable().optional(),
  limits: z.record(z.string(), z.number().finite().nonnegative()).optional(),
  reason: z.string().min(3).max(500),
}).strict();
const scopePatchSchema = z.object({
  expectedVersion: z.number().int().positive(),
  mode: z.enum(['all', 'selected']),
  resourceIds: z.array(z.string().min(1).max(200)).max(1000),
}).strict();
const policyPatchSchema = z.object({
  expectedVersion: z.number().int().positive(),
  value: z.union([
    z.boolean(), z.string().max(500), z.number().finite(), z.null(),
    z.array(z.string().max(200)).max(1000),
    z.record(z.string(), z.union([z.boolean(), z.string().max(500), z.number().finite(), z.null()])),
  ]),
}).strict();
const assignmentPatchSchema = z.object({
  expectedVersion: z.number().int().positive(),
  assignments: z.array(z.object({
    assigneeType: z.enum(['everyone', 'user', 'directory_group', 'agent']),
    assigneeId: z.string().min(1).max(200).optional(),
    effect: z.enum(['allow', 'deny']),
    origin: z.enum(['direct', 'policy_default']).optional(),
  }).strict()).max(5000),
}).strict();
const contentGrantSchema = z.object({
  tenantId: z.string().min(2).max(64).optional(),
  subjectUserId: z.string().min(1).max(128),
  targetType: z.enum(['session', 'guardrail_collection']),
  targetId: z.string().min(1).max(200),
  scopes: z.array(z.enum(['qa_read', 'session_export', 'guardrail_read'])).min(1).max(3),
  purpose: z.string().min(3).max(500),
  reasonCode: z.string().min(3).max(120),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
const contentGrantRevokeSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();

const preferenceSchema = z.object({
  resourceType: z.string().min(1).max(80),
  resourceId: z.string().min(1).max(200),
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export function createGovernanceAccessRouter(deps: {
  memberships: PgMembershipStore;
  entitlements: PgEntitlementStore;
  assignments: PgAssignmentStore;
  audit: GovernanceAuditStore;
  contentAccess?: PgContentAccessGrantStore;
  projectionOutbox?: PgGovernanceProjectionOutboxStore;
  projectionReconciler?: GovernanceProjectionReconciler;
}): Router {
  const router = Router();
  const personas = new WeakMap<Request, 'platform_admin' | 'org_admin' | 'member'>();
  const canManageTenant = (req: Request) => {
    const persona = personas.get(req);
    return persona === 'platform_admin' || persona === 'org_admin';
  };
  const tenantFor = (req: Request, requested?: string): string | null => {
    if (personas.get(req) === 'platform_admin') return requested ?? req.user?.tenantId ?? null;
    if (!req.user?.tenantId || (requested && requested !== req.user.tenantId)) return null;
    return req.user.tenantId;
  };

  router.use(async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const platformAdmin = await deps.memberships.getPlatformAdmin(req.user.sub);
    if (platformAdmin?.status === 'active') {
      personas.set(req, 'platform_admin');
      return next();
    }
    const membership = await deps.memberships.getMembership(req.user.tenantId, req.user.sub);
    if (!membership || membership.status !== 'active') {
      return res.status(403).json({ error: 'Governance membership inactive', code: 'GOVERNANCE_MEMBERSHIP_INACTIVE' });
    }
    personas.set(req, membership.persona);
    next();
  });

  router.use(async (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const user = req.user!;
    const requestedTenantId = typeof req.query.tenantId === 'string'
      ? req.query.tenantId
      : typeof req.body?.tenantId === 'string' ? req.body.tenantId : user.tenantId;
    const correlationId = `governance-access:${randomUUID()}`;
    const actorPersona = personas.get(req)!;
    let intentAuditId: string;
    try {
      const intent = await deps.audit.append({
        correlationId, actorType: 'user', actorUserId: user.sub, actorPersona,
        actorTenantId: user.tenantId, action: `governance.access.${req.method.toLowerCase()}`,
        targetType: 'governance_access_api', targetId: req.path,
        targetTenantId: requestedTenantId, purpose: 'governance access mutation',
        result: 'intent', metadata: {},
      });
      intentAuditId = intent.auditId;
    } catch {
      return res.status(503).json({ error: '治理审计不可用', code: 'GOVERNANCE_AUDIT_UNAVAILABLE' });
    }
    const sendJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      void deps.audit.append({
        correlationId, actorType: 'user', actorUserId: user.sub, actorPersona,
        actorTenantId: user.tenantId, action: `governance.access.${req.method.toLowerCase()}`,
        targetType: 'governance_access_api', targetId: req.path,
        targetTenantId: requestedTenantId, purpose: 'governance access mutation',
        result: res.statusCode < 400 ? 'succeeded' : 'failed', metadata: { statusCode: res.statusCode },
      }).then(event => {
        const payload = body && typeof body === 'object' && !Array.isArray(body)
          ? { ...(body as Record<string, unknown>), auditId: event.auditId }
          : { data: body, auditId: event.auditId };
        sendJson(payload);
      }).catch(async () => {
        if (deps.projectionOutbox) {
          await deps.projectionOutbox.enqueue({
            tenantId: requestedTenantId,
            projector: 'audit_terminal',
            idempotencyKey: `${correlationId}:${res.statusCode < 400 ? 'succeeded' : 'failed'}`,
            payload: {
              correlationId,
              actorType: 'user',
              actorUserId: user.sub,
              actorPersona,
              actorTenantId: user.tenantId,
              action: `governance.access.${req.method.toLowerCase()}`,
              targetType: 'governance_access_api',
              targetId: req.path,
              targetTenantId: requestedTenantId,
              purpose: 'governance access mutation',
              result: res.statusCode < 400 ? 'succeeded' : 'failed',
              metadata: { statusCode: res.statusCode },
            },
          }).catch(() => undefined);
        }
        const payload = body && typeof body === 'object' && !Array.isArray(body)
          ? { ...(body as Record<string, unknown>), auditId: intentAuditId, auditCompletion: 'pending' }
          : { data: body, auditId: intentAuditId, auditCompletion: 'pending' };
        sendJson(payload);
      });
      return res;
    }) as typeof res.json;
    next();
  });

  router.get('/projections/:projectionId', async (req, res) => {
    if (!canManageTenant(req) || !deps.projectionOutbox) return res.status(404).json({ error: 'Projection not found' });
    const projection = await deps.projectionOutbox.get(req.params.projectionId);
    if (!projection || tenantFor(req, projection.tenantId) !== projection.tenantId) {
      return res.status(404).json({ error: 'Projection not found' });
    }
    res.json(projection);
  });

  router.get('/memberships', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    res.json({ memberships: await deps.memberships.listMemberships(tenantId) });
  });

  router.patch('/memberships/:userId', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const parsed = membershipPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    try {
      const membership = await deps.memberships.updateMembershipIdentity(tenantId, req.params.userId, {
        ...parsed.data, updatedBy: req.user!.sub,
      });
      let projectionId: string | undefined;
      if (deps.projectionOutbox) {
        const projection = await deps.projectionOutbox.enqueue({
          tenantId,
          projector: 'membership',
          idempotencyKey: `${membership.userId}:${membership.version}`,
          payload: {
            tenantId,
            userId: membership.userId,
            persona: membership.persona,
            status: membership.status,
            version: membership.version,
          },
        });
        projectionId = projection.outboxId;
        void deps.projectionReconciler?.reconcileOne();
      }
      res.json({
        ...membership,
        compatibilityProjection: deps.projectionOutbox ? 'applied_with_projection_pending' : 'not_configured',
        ...(projectionId ? { projectionId } : {}),
      });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.patch('/platform-admins/:userId', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = platformAdminPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    try {
      res.json(await deps.memberships.updatePlatformAdmin(req.params.userId, {
        ...parsed.data, updatedBy: req.user!.sub,
      }));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/entitlements', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const [entitlement, scopes, policies] = await Promise.all([
      deps.entitlements.getEntitlementSet(tenantId),
      deps.entitlements.listResourceScopes(tenantId),
      deps.entitlements.getPolicies(tenantId),
    ]);
    res.json({ entitlement, scopes, policies });
  });

  router.patch('/entitlements', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = entitlementPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    try {
      const { reason, ...patch } = parsed.data;
      const entitlement = await deps.entitlements.updateEntitlementSet(tenantId, {
        ...patch, updatedBy: req.user!.sub, updateReason: reason,
      });
      let projectionId: string | undefined;
      if (deps.projectionOutbox) {
        const projection = await deps.projectionOutbox.enqueue({
          tenantId, projector: 'tenant_settings',
          idempotencyKey: `entitlement:${entitlement.version}`,
          payload: { tenantId, source: 'entitlement', version: entitlement.version },
        });
        projectionId = projection.outboxId;
        void deps.projectionReconciler?.reconcileOne();
      }
      res.json({ ...entitlement, compatibilityProjection: deps.projectionOutbox ? 'applied_with_projection_pending' : 'not_configured', ...(projectionId ? { projectionId } : {}) });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/entitlement-scopes/:resourceType', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = scopePatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    try {
      const scope = await deps.entitlements.replaceResourceScope(
        tenantId, req.params.resourceType as EntitlementResourceType,
        { ...parsed.data, updatedBy: req.user!.sub },
      );
      let projectionId: string | undefined;
      if (deps.projectionOutbox) {
        const projection = await deps.projectionOutbox.enqueue({
          tenantId, projector: 'tenant_settings',
          idempotencyKey: `scope:${scope.resourceType}:${scope.version}`,
          payload: { tenantId, source: 'scope', resourceType: scope.resourceType, version: scope.version },
        });
        projectionId = projection.outboxId;
        void deps.projectionReconciler?.reconcileOne();
      }
      res.json({ ...scope, compatibilityProjection: deps.projectionOutbox ? 'applied_with_projection_pending' : 'not_configured', ...(projectionId ? { projectionId } : {}) });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/policies/:policyKey', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const parsed = policyPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    try {
      const policy = await deps.entitlements.updatePolicy(
        tenantId, req.params.policyKey as TenantPolicyKey,
        parsed.data.value, parsed.data.expectedVersion, req.user!.sub,
      );
      let projectionId: string | undefined;
      if (deps.projectionOutbox) {
        const projection = await deps.projectionOutbox.enqueue({
          tenantId, projector: 'tenant_settings',
          idempotencyKey: `policy:${policy.policyKey}:${policy.version}`,
          payload: { tenantId, source: 'policy', policyKey: policy.policyKey, version: policy.version },
        });
        projectionId = projection.outboxId;
        void deps.projectionReconciler?.reconcileOne();
      }
      res.json({ ...policy, compatibilityProjection: deps.projectionOutbox ? 'applied_with_projection_pending' : 'not_configured', ...(projectionId ? { projectionId } : {}) });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/assignments/:resourceType/:resourceId', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const assignmentSet = await deps.assignments.getAssignmentSet(
      tenantId, req.params.resourceType as AssignmentResourceType, req.params.resourceId,
    );
    if (!assignmentSet) return res.status(404).json({ error: 'Assignment set not found' });
    res.json(assignmentSet);
  });

  router.put('/assignments/:resourceType/:resourceId', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const parsed = assignmentPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    try {
      const assignmentSet = await deps.assignments.replaceAssignments(
        tenantId, req.params.resourceType as AssignmentResourceType, req.params.resourceId,
        parsed.data.assignments, parsed.data.expectedVersion, req.user!.sub,
      );
      let projectionId: string | undefined;
      if (deps.projectionOutbox) {
        const projection = await deps.projectionOutbox.enqueue({
          tenantId, projector: 'assignment',
          idempotencyKey: `${assignmentSet.resourceType}:${assignmentSet.resourceId}:${assignmentSet.version}`,
          payload: {
            tenantId, resourceType: assignmentSet.resourceType,
            resourceId: assignmentSet.resourceId, version: assignmentSet.version,
          },
        });
        projectionId = projection.outboxId;
        void deps.projectionReconciler?.reconcileOne();
      }
      res.json({ ...assignmentSet, compatibilityProjection: deps.projectionOutbox ? 'applied_with_projection_pending' : 'not_configured', ...(projectionId ? { projectionId } : {}) });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/content-grants', async (req, res) => {
    if (!deps.contentAccess) return res.status(503).json({ error: 'Content Access Grant unavailable' });
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const subjectUserId = typeof req.query.subjectUserId === 'string' ? req.query.subjectUserId : undefined;
    res.json({ grants: await deps.contentAccess.list({ tenantId, ...(subjectUserId ? { subjectUserId } : {}) }) });
  });

  router.post('/content-grants', async (req, res) => {
    if (!deps.contentAccess) return res.status(503).json({ error: 'Content Access Grant unavailable' });
    if (personas.get(req) !== 'org_admin') {
      return res.status(403).json({ error: 'Tenant administrator approval required' });
    }
    const parsed = contentGrantSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, parsed.data.tenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const subject = await deps.memberships.getPlatformAdmin(parsed.data.subjectUserId);
    if (!subject || subject.status !== 'active') {
      return res.status(409).json({ error: 'Active platform administrator required' });
    }
    try {
      res.status(201).json(await deps.contentAccess.create({
        tenantId,
        subjectUserId: parsed.data.subjectUserId,
        targetType: parsed.data.targetType,
        targetId: parsed.data.targetId,
        scopes: parsed.data.scopes,
        purpose: parsed.data.purpose,
        reasonCode: parsed.data.reasonCode,
        expiresAt: parsed.data.expiresAt,
        createdBy: req.user!.sub,
      }));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/content-grants/:grantId/revoke', async (req, res) => {
    if (!deps.contentAccess) return res.status(503).json({ error: 'Content Access Grant unavailable' });
    if (personas.get(req) !== 'org_admin') {
      return res.status(403).json({ error: 'Tenant administrator approval required' });
    }
    const parsed = contentGrantRevokeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    try {
      res.json(await deps.contentAccess.revoke({
        tenantId, grantId: req.params.grantId, expectedRevision: parsed.data.expectedRevision,
        revokedBy: req.user!.sub,
      }));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/preferences', async (req, res) => {
    res.json({ preferences: await deps.assignments.listUserPreferences(req.user!.sub) });
  });

  router.put('/preferences', async (req, res) => {
    const parsed = preferenceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    try {
      const preference = await deps.assignments.setUserPreference(
        req.user!.sub, parsed.data.resourceType, parsed.data.resourceId,
        parsed.data.enabled, parsed.data.expectedVersion,
      );
      let projectionId: string | undefined;
      if (deps.projectionOutbox) {
        const projection = await deps.projectionOutbox.enqueue({
          tenantId: req.user!.tenantId, projector: 'preference',
          idempotencyKey: `${preference.userId}:${preference.resourceType}:${preference.resourceId}:${preference.version}`,
          payload: { userId: preference.userId, tenantId: req.user!.tenantId, version: preference.version },
        });
        projectionId = projection.outboxId;
        void deps.projectionReconciler?.reconcileOne();
      }
      res.json({ ...preference, compatibilityProjection: deps.projectionOutbox ? 'applied_with_projection_pending' : 'not_configured', ...(projectionId ? { projectionId } : {}) });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
