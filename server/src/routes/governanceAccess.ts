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
      }).catch(() => {
        const payload = body && typeof body === 'object' && !Array.isArray(body)
          ? { ...(body as Record<string, unknown>), auditId: intentAuditId, auditCompletion: 'pending' }
          : { data: body, auditId: intentAuditId, auditCompletion: 'pending' };
        sendJson(payload);
      });
      return res;
    }) as typeof res.json;
    next();
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
      res.json(await deps.memberships.updateMembershipIdentity(tenantId, req.params.userId, {
        ...parsed.data, updatedBy: req.user!.sub,
      }));
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
      res.json(await deps.entitlements.updateEntitlementSet(tenantId, {
        ...patch, updatedBy: req.user!.sub, updateReason: reason,
      }));
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
      res.json(await deps.entitlements.replaceResourceScope(
        tenantId, req.params.resourceType as EntitlementResourceType,
        { ...parsed.data, updatedBy: req.user!.sub },
      ));
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
      res.json(await deps.entitlements.updatePolicy(
        tenantId, req.params.policyKey as TenantPolicyKey,
        parsed.data.value, parsed.data.expectedVersion, req.user!.sub,
      ));
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
      res.json(await deps.assignments.replaceAssignments(
        tenantId, req.params.resourceType as AssignmentResourceType, req.params.resourceId,
        parsed.data.assignments, parsed.data.expectedVersion, req.user!.sub,
      ));
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
      res.json(await deps.assignments.setUserPreference(
        req.user!.sub, parsed.data.resourceType, parsed.data.resourceId,
        parsed.data.enabled, parsed.data.expectedVersion,
      ));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
