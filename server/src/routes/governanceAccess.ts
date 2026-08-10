import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';

import type { PgAssignmentStore } from '../data/assignments/index.js';
import type { AssignmentResourceType } from '../data/assignments/types.js';
import type { PgEntitlementStore } from '../data/entitlements/index.js';
import type { EntitlementResourceType, TenantPolicyKey } from '../data/entitlements/types.js';
import { governanceDigest, type GovernanceAuditStore } from '../data/governance-audit/index.js';
import { MembershipInvariantError, type MembershipIdentityPatch, type PgMembershipStore, type TenantMembership } from '../data/memberships/index.js';
import type { PgContentAccessGrantStore } from '../data/contentAccess/index.js';
import type { GovernanceProjectionReconciler, PgGovernanceProjectionOutboxStore } from '../data/governanceProjection/index.js';

const membershipMutationShape = {
  expectedVersion: z.number().int().positive(),
  persona: z.enum(['member', 'org_admin']).optional(),
  isOwner: z.boolean().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  reason: z.string().min(3).max(500).optional(),
};
const membershipPreviewSchema = z.object(membershipMutationShape).strict();
const membershipPatchSchema = z.object({
  ...membershipMutationShape,
  previewId: z.string().regex(/^mpv1\.[a-f0-9]{64}$/),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
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

const auditQuerySchema = z.object({
  tenantId: z.string().min(2).max(64).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const preferenceSchema = z.object({
  resourceType: z.string().min(1).max(80),
  resourceId: z.string().min(1).max(200),
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

type MembershipMutation = z.infer<typeof membershipPreviewSchema>;
type GovernancePersona = 'platform_admin' | 'org_admin' | 'member';

function membershipBaseline(membership: TenantMembership): Record<string, unknown> {
  return {
    tenantId: membership.tenantId,
    userId: membership.userId,
    persona: membership.persona,
    isOwner: membership.isOwner,
    status: membership.status,
    version: membership.version,
  };
}

function membershipChange(mutation: MembershipMutation): Record<string, unknown> {
  return {
    expectedVersion: mutation.expectedVersion,
    ...(mutation.persona !== undefined ? { persona: mutation.persona } : {}),
    ...(mutation.isOwner !== undefined ? { isOwner: mutation.isOwner } : {}),
    ...(mutation.status !== undefined ? { status: mutation.status } : {}),
    ...(mutation.reason !== undefined ? { reason: mutation.reason } : {}),
  };
}

function previewSignature(secret: string, input: Record<string, unknown>): string {
  return createHmac('sha256', secret).update(governanceDigest(input)).digest('hex');
}

function previewMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function membershipErrorStatus(error: unknown): number {
  if (!(error instanceof MembershipInvariantError)) return 409;
  return error.code === 'MEMBERSHIP_CHANGE_FORBIDDEN'
    || error.code === 'PLATFORM_RECOVERY_SCOPE_REQUIRED' ? 403 : 409;
}

export function createGovernanceAccessRouter(deps: {
  memberships: PgMembershipStore;
  entitlements: PgEntitlementStore;
  assignments: PgAssignmentStore;
  audit: GovernanceAuditStore;
  contentAccess?: PgContentAccessGrantStore;
  projectionOutbox?: PgGovernanceProjectionOutboxStore;
  projectionReconciler?: GovernanceProjectionReconciler;
  membershipPreviewSecret: string;
  membershipPreviewTtlMs?: number;
  now?: () => Date;
}): Router {
  if (deps.membershipPreviewSecret.length < 32) {
    throw new Error('membershipPreviewSecret must contain at least 32 characters');
  }
  const router = Router();
  const personas = new WeakMap<Request, GovernancePersona>();
  const actorMemberships = new WeakMap<Request, TenantMembership>();
  const now = deps.now ?? (() => new Date());
  const previewTtlMs = deps.membershipPreviewTtlMs ?? 5 * 60_000;
  const canManageTenant = (req: Request) => {
    const persona = personas.get(req);
    return persona === 'platform_admin' || persona === 'org_admin';
  };
  const tenantFor = (req: Request, requested?: string): string | null => {
    if (personas.get(req) === 'platform_admin') return requested ?? req.user?.tenantId ?? null;
    if (!req.user?.tenantId || (requested && requested !== req.user.tenantId)) return null;
    return req.user.tenantId;
  };
  const authorizeMembershipMutation = (
    req: Request,
    tenantId: string,
    current: TenantMembership,
    mutation: MembershipMutation,
    explicitTenantScope: boolean,
  ): MembershipIdentityPatch['authorization'] => {
    const persona = mutation.persona ?? current.persona;
    const isOwner = mutation.isOwner ?? current.isOwner;
    const status = mutation.status ?? current.status;
    if (personas.get(req) === 'platform_admin') {
      const recoveryOnly = persona === 'org_admin' && isOwner && status === 'active'
        && mutation.persona !== 'member' && mutation.isOwner !== false && mutation.status !== 'disabled';
      if (!explicitTenantScope || tenantId === req.user!.tenantId || !mutation.reason?.trim() || !recoveryOnly) {
        throw new MembershipInvariantError('PLATFORM_RECOVERY_SCOPE_REQUIRED');
      }
      return { kind: 'platform_recovery', actorTenantId: req.user!.tenantId, reason: mutation.reason };
    }
    const actor = actorMemberships.get(req);
    if (!actor || actor.tenantId !== tenantId || actor.status !== 'active' || actor.persona !== 'org_admin') {
      throw new MembershipInvariantError('MEMBERSHIP_CHANGE_FORBIDDEN');
    }
    if (!actor.isOwner) {
      const changesAdminIdentity = persona !== current.persona || isOwner !== current.isOwner;
      const changesPeerAdminStatus = status !== current.status
        && (current.persona === 'org_admin' || current.isOwner);
      if (changesAdminIdentity || changesPeerAdminStatus) {
        throw new MembershipInvariantError('MEMBERSHIP_CHANGE_FORBIDDEN');
      }
    }
    return { kind: 'tenant_member', actorTenantId: req.user!.tenantId };
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
    actorMemberships.set(req, membership);
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
    const auditReason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    let intentAuditId: string;
    try {
      const intent = await deps.audit.append({
        correlationId, actorType: 'user', actorUserId: user.sub, actorPersona,
        actorTenantId: user.tenantId, action: `governance.access.${req.method.toLowerCase()}`,
        targetType: 'governance_access_api', targetId: req.path,
        targetTenantId: requestedTenantId, purpose: 'governance access mutation',
        ...(auditReason ? { reason: auditReason } : {}),
        result: 'intent', metadata: {},
      });
      intentAuditId = intent.auditId;
      res.locals.governanceChangeId = intentAuditId;
    } catch {
      return res.status(503).json({ error: '治理审计不可用', code: 'GOVERNANCE_AUDIT_UNAVAILABLE' });
    }
    const sendJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      void deps.audit.append({
        correlationId, changeId: intentAuditId,
        actorType: 'user', actorUserId: user.sub, actorPersona,
        actorTenantId: user.tenantId, action: `governance.access.${req.method.toLowerCase()}`,
        targetType: 'governance_access_api', targetId: req.path,
        targetTenantId: requestedTenantId, purpose: 'governance access mutation',
        ...(auditReason ? { reason: auditReason } : {}),
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
              changeId: intentAuditId,
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

  router.post('/memberships/:userId/preview', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const parsed = membershipPreviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const requestedTenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    if (personas.get(req) === 'platform_admin' && requestedTenantId === undefined) {
      return res.status(403).json({ error: 'Explicit customer tenant scope required', code: 'PLATFORM_RECOVERY_SCOPE_REQUIRED' });
    }
    const tenantId = tenantFor(req, requestedTenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    try {
      const current = await deps.memberships.getMembership(tenantId, req.params.userId);
      if (!current) throw new MembershipInvariantError('MEMBERSHIP_NOT_FOUND');
      if (current.version !== parsed.data.expectedVersion) {
        throw new MembershipInvariantError('MEMBERSHIP_VERSION_CONFLICT');
      }
      authorizeMembershipMutation(req, tenantId, current, parsed.data, requestedTenantId !== undefined);
      const baselineDigest = governanceDigest(membershipBaseline(current));
      const expiresAt = new Date(now().getTime() + previewTtlMs).toISOString();
      const signatureInput = {
        version: 1,
        actorUserId: req.user!.sub,
        actorTenantId: req.user!.tenantId,
        actorPersona: personas.get(req)!,
        tenantId,
        userId: req.params.userId,
        expectedVersion: parsed.data.expectedVersion,
        baselineDigest,
        expiresAt,
        changeDigest: governanceDigest(membershipChange(parsed.data)),
      };
      res.json({
        previewId: `mpv1.${previewSignature(deps.membershipPreviewSecret, signatureInput)}`,
        baselineDigest,
        expiresAt,
        expectedVersion: parsed.data.expectedVersion,
        changeId: res.locals.governanceChangeId,
      });
    } catch (error) {
      res.status(membershipErrorStatus(error)).json({
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof MembershipInvariantError ? { code: error.code } : {}),
      });
    }
  });

  router.patch('/memberships/:userId', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const parsed = membershipPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const requestedTenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    if (personas.get(req) === 'platform_admin' && requestedTenantId === undefined) {
      return res.status(403).json({ error: 'Explicit customer tenant scope required', code: 'PLATFORM_RECOVERY_SCOPE_REQUIRED' });
    }
    const tenantId = tenantFor(req, requestedTenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    try {
      const { previewId, baselineDigest, expiresAt, reason, ...change } = parsed.data;
      if (Date.parse(expiresAt) <= now().getTime()) {
        return res.status(409).json({ error: 'Membership preview expired', code: 'MEMBERSHIP_PREVIEW_EXPIRED' });
      }
      const mutation: MembershipMutation = { ...change, ...(reason ? { reason } : {}) };
      const signatureInput = {
        version: 1,
        actorUserId: req.user!.sub,
        actorTenantId: req.user!.tenantId,
        actorPersona: personas.get(req)!,
        tenantId,
        userId: req.params.userId,
        expectedVersion: mutation.expectedVersion,
        baselineDigest,
        expiresAt,
        changeDigest: governanceDigest(membershipChange(mutation)),
      };
      const expectedPreviewId = `mpv1.${previewSignature(deps.membershipPreviewSecret, signatureInput)}`;
      if (!previewMatches(previewId, expectedPreviewId)) {
        return res.status(409).json({ error: 'Membership preview invalid', code: 'MEMBERSHIP_PREVIEW_INVALID' });
      }
      const current = await deps.memberships.getMembership(tenantId, req.params.userId);
      if (!current || current.version !== mutation.expectedVersion
        || governanceDigest(membershipBaseline(current)) !== baselineDigest) {
        return res.status(409).json({
          error: 'Membership preview baseline changed',
          code: 'MEMBERSHIP_PREVIEW_BASELINE_CONFLICT',
        });
      }
      const authorization = authorizeMembershipMutation(
        req, tenantId, current, mutation, requestedTenantId !== undefined,
      );
      const membership = await deps.memberships.updateMembershipIdentity(tenantId, req.params.userId, {
        ...change,
        updatedBy: req.user!.sub,
        authorization,
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
            isOwner: membership.isOwner,
            status: membership.status,
            version: membership.version,
          },
        });
        projectionId = projection.outboxId;
        void deps.projectionReconciler?.reconcileOne();
      }
      res.json({
        ...membership,
        changeId: res.locals.governanceChangeId,
        effectiveAt: membership.updatedAt ?? now().toISOString(),
        projectionStatus: deps.projectionOutbox ? 'pending' : 'not_configured',
        compatibilityProjection: deps.projectionOutbox ? 'applied_with_projection_pending' : 'not_configured',
        ...(projectionId ? { projectionId } : {}),
      });
    } catch (error) {
      res.status(membershipErrorStatus(error)).json({
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof MembershipInvariantError ? { code: error.code } : {}),
      });
    }
  });

  router.get('/platform-admins', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    res.json({ platformAdmins: await deps.memberships.listPlatformAdmins() });
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

  router.get('/audit-events', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid query' });
    const persona = personas.get(req);
    const targetTenantId = persona === 'platform_admin'
      ? parsed.data.tenantId
      : tenantFor(req, parsed.data.tenantId);
    if (persona !== 'platform_admin' && !targetTenantId) {
      return res.status(403).json({ error: 'Tenant scope denied' });
    }
    if (!deps.audit.list) return res.status(503).json({ error: 'Governance audit query unavailable' });
    const events = await deps.audit.list({
      ...(targetTenantId ? { targetTenantId } : {}),
      ...(parsed.data.before ? { before: parsed.data.before } : {}),
      limit: parsed.data.limit,
    });
    res.json({ events, nextBefore: events.length === parsed.data.limit ? events.at(-1)?.occurredAt : undefined });
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
