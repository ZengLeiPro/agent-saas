import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request } from 'express';
import type { TenantMemoryFeatureStatusMap } from '../../../shared/src/types/tenant.js';
import type { PgAssignmentStore } from '../data/assignments/index.js';
import type { BillingMemberBudgetOverview } from '../data/billing/types.js';
import type { AssignmentResourceType } from '../data/assignments/types.js';
import type { PgEntitlementStore } from '../data/entitlements/index.js';
import type { EntitlementResourceType } from '../data/entitlements/types.js';
import { governanceDigest, type GovernanceAuditStore } from '../data/governance-audit/index.js';
import { MembershipInvariantError, type MembershipIdentityPatch, type PgMembershipStore, type TenantMembership } from '../data/memberships/index.js';
import type { PgContentAccessGrantStore } from '../data/contentAccess/index.js';
import type { PgOAuthGrantStore } from '../data/oauthGrants/index.js';
import { DEFAULT_TENANT_ID, type TenantSettings } from '../data/tenants/types.js';
import type { OAuthGrant } from '../data/oauthGrants/types.js';
import type { GovernanceProjectionReconciler, PgGovernanceProjectionOutboxStore } from '../data/governanceProjection/index.js';
import { registerGovernanceTenantLifecycleRoutes } from './governanceTenantLifecycleRoutes.js';
import { registerGovernanceEntitlementRoutes } from './governanceEntitlementRoutes.js';
import { registerGovernanceOAuthGrantRoutes } from './governanceOAuthGrantRoutes.js';
import { getGovernanceMemberUsagePolicy } from './governanceMemberUsage.js';
import { registerGovernanceTenantSettingsRoutes } from './governanceTenantSettingsRoutes.js';
import type { TenantSettingsPatch } from './tenantSettingsValidation.js';
import { registerGovernanceOrganizationAccessRoutes } from './governanceOrganizationAccessRoutes.js';
import { registerGovernanceMemoryRoutes } from './governanceMemoryRoutes.js';
import {
  ASSIGNMENT_RESOURCE_TYPES,
  assignmentBaseline,
  assignmentPatchSchema,
  assignmentPreviewSchema,
  assignmentResourceTypeSchema,
  auditQuerySchema,
  contentGrantRevokeSchema,
  contentGrantSchema,
  membershipBaseline,
  membershipChange,
  membershipCreateSchema,
  membershipErrorStatus,
  membershipPatchSchema,
  membershipPreviewSchema,
  platformAdminPatchSchema,
  preferenceSchema,
  previewMatches,
  previewSignature,
  type AssignmentMutation,
  type GovernancePersona,
  type MembershipAllowedAction,
  type MembershipCreateInput,
  type MembershipMutation,
} from './governanceAccessValidation.js';
import { entitlementDependencyImpact, oauthDependencyImpact, tenantDependencyImpact,
  type GovernanceDependencyImpactResolver } from './governanceImpactAuthority.js';

export function createGovernanceAccessRouter(deps: {
  memberships: PgMembershipStore;
  entitlements: PgEntitlementStore;
  assignments: PgAssignmentStore;
  changeJobs?: { findActiveForTarget(
    tenantId: string, jobType: 'user_offboarding', targetType: 'user', targetId: string,
  ): Promise<unknown | null> };
  oauthGrants?: PgOAuthGrantStore;
  reconcileOAuthGrants?: (tenantId: string, subjectUserId: string) => Promise<void>;
  revokeOAuthGrant?: (grant: OAuthGrant, user: NonNullable<Request['user']>) => Promise<void>;
  directoryGroups?: {
    getGroup(tenantId: string, groupId: string): Promise<{ groupId: string; status: 'active' | 'disabled' } | null>;
    listGroups(tenantId: string): Promise<unknown[]>;
    getAssignmentSnapshot(tenantId: string, groupId: string): Promise<{
      memberUserIds: string[]; digest: string; fresh: boolean;
    } | null>;
  };
  resolveAssignmentResource?: (
    tenantId: string,
    resourceType: AssignmentResourceType,
    resourceId: string,
  ) => Promise<'valid' | 'not_found' | 'unavailable'>;
  resolveEntitlementResource?: (
    resourceType: EntitlementResourceType,
    resourceId: string,
  ) => Promise<{ status: 'valid'; version: number } | { status: 'not_found' | 'unavailable' }>;
  listEntitlementResources?: (
    resourceType: EntitlementResourceType,
  ) => Promise<{ status: 'valid'; items: Array<{ resourceId: string; version: number }> } | { status: 'unavailable' }>;
  resolveDependencyImpact?: GovernanceDependencyImpactResolver;
  getPlatformAdminProfile?: (userId: string) => { username: string; displayName: string; accountStatus: 'active' | 'disabled' } | null;
  getMemberProfile?: (tenantId: string, userId: string) => {
    userId: string; username: string; displayName: string; position?: string;
    accountStatus: 'active' | 'disabled'; dingtalkBound: boolean; createdAt: string; updatedAt: string;
    debugMode?: boolean; debugModeAvailable?: boolean;
  } | null;
  validateMemberDebugMode?: (tenantId: string, debugMode: boolean) => string | null;
  getMemberBudgetOverview?: (tenantId: string, userId: string) => Promise<BillingMemberBudgetOverview>;
  createMember?: (input: MembershipCreateInput & { tenantId: string; createdBy: string }) => Promise<{
    userId: string;
    membership: TenantMembership;
  }>;
  createTenant?: (input: { id: string; name: string; createdBy: string }) => Promise<{
    id: string; name: string; createdAt: string; createdBy: string; updatedAt: string;
  }>;
  rollbackTenantCreate?: (tenantId: string) => Promise<void>;
  getTenantSettings?: (tenantId: string) => {
    settings: TenantSettings;
    updatedAt: string;
    memoryFeatureStatus?: TenantMemoryFeatureStatusMap;
  } | undefined;
  updateTenantSettings?: (
    tenantId: string,
    settings: TenantSettingsPatch,
    expectedUpdatedAt: string,
  ) => Promise<{
    settings: TenantSettings;
    updatedAt: string;
    memoryFeatureStatus?: TenantMemoryFeatureStatusMap;
  }>;
  getTenantLifecycle?: (tenantId: string) => { id: string; name?: string; disabled?: boolean; updatedAt: string } | undefined;
  setTenantDisabled?: (
    tenantId: string,
    disabled: boolean,
    actorUserId: string,
    expectedUpdatedAt: string,
  ) => Promise<{ id: string; disabled?: boolean; updatedAt: string }>;
  onTenantLifecycleChanged?: (change: {
    tenantId: string;
    disabled: boolean;
    actorUserId: string;
    reason: string;
    updatedAt: string;
  }) => Promise<'applied' | 'pending' | void>;
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
  const assignmentSubjectError = async (
    tenantId: string,
    assignments: AssignmentMutation['assignments'],
  ): Promise<{ status: number; body: { error: string; code: string } } | null> => {
    for (const assignment of assignments) {
      if (assignment.assigneeType === 'user') {
        const subject = await deps.memberships.getMembership(tenantId, assignment.assigneeId!);
        if (!subject || subject.status !== 'active') {
          return { status: 409, body: { error: 'Active same-tenant membership required', code: 'ASSIGNMENT_USER_SUBJECT_INVALID' } };
        }
        if (!deps.changeJobs) {
          return { status: 503, body: { error: 'Offboarding authority unavailable', code: 'OFFBOARDING_AUTHORITY_UNAVAILABLE' } };
        }
        if (await deps.changeJobs.findActiveForTarget(tenantId, 'user_offboarding', 'user', assignment.assigneeId!)) {
          return { status: 409, body: { error: 'Assignment subject offboarding is active', code: 'ASSIGNMENT_SUBJECT_OFFBOARDING_ACTIVE' } };
        }
      }
      if (assignment.assigneeType === 'directory_group') {
        if (!deps.directoryGroups) {
          return { status: 503, body: { error: 'Directory group authority unavailable', code: 'DIRECTORY_GROUP_AUTHORITY_UNAVAILABLE' } };
        }
        const group = await deps.directoryGroups.getAssignmentSnapshot(tenantId, assignment.assigneeId!);
        if (!group) {
          return { status: 409, body: { error: 'Active same-tenant directory group required', code: 'ASSIGNMENT_GROUP_SUBJECT_INVALID' } };
        }
        if (!group.fresh) {
          return { status: 503, body: { error: 'Directory group projection is stale', code: 'DIRECTORY_GROUP_AUTHORITY_STALE' } };
        }
      }
    }
    return null;
  };
  const assignmentDirectorySnapshot = async (
    tenantId: string,
    assignments: AssignmentMutation['assignments'],
  ): Promise<Record<string, unknown>> => {
    const includesEveryone = assignments.some(item => item.assigneeType === 'everyone');
    const activeMemberships = includesEveryone
      ? (await deps.memberships.listMemberships(tenantId))
          .filter(item => item.status === 'active')
          .map(item => ({ userId: item.userId, version: item.version })).sort((a, b) => a.userId.localeCompare(b.userId))
      : [];
    const groupIds = [...new Set(assignments
      .filter(item => item.assigneeType === 'directory_group')
      .map(item => item.assigneeId!))].sort();
    const groups = [];
    for (const groupId of groupIds) {
      const snapshot = await deps.directoryGroups?.getAssignmentSnapshot(tenantId, groupId);
      if (!snapshot || !snapshot.fresh) throw new Error('DIRECTORY_GROUP_AUTHORITY_STALE');
      groups.push({ groupId, digest: snapshot.digest, memberUserIds: snapshot.memberUserIds });
    }
    return { activeMemberships, groups };
  };
  const assignmentResourceError = async (
    tenantId: string,
    resourceType: AssignmentResourceType,
    resourceId: string,
  ): Promise<{ status: number; body: { error: string; code: string } } | null> => {
    if (!deps.resolveAssignmentResource) {
      return { status: 503, body: { error: 'Assignment resource authority unavailable', code: 'ASSIGNMENT_RESOURCE_AUTHORITY_UNAVAILABLE' } };
    }
    const result = await deps.resolveAssignmentResource(tenantId, resourceType, resourceId);
    if (result === 'unavailable') {
      return { status: 503, body: { error: 'Assignment resource authority unavailable', code: 'ASSIGNMENT_RESOURCE_AUTHORITY_UNAVAILABLE' } };
    }
    if (result === 'not_found') {
      return { status: 409, body: { error: 'Same-tenant assignment resource required', code: 'ASSIGNMENT_RESOURCE_INVALID' } };
    }
    return null;
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

  const membershipActionsFor = (
    req: Request,
    tenantId: string,
    target: TenantMembership,
  ): MembershipAllowedAction[] => {
    if (personas.get(req) === 'platform_admin') {
      if (tenantId === req.user!.tenantId
        || (target.persona === 'org_admin' && target.isOwner && target.status === 'active')) return [];
      return [{
        id: 'recover_owner', label: '恢复为 Owner',
        change: { persona: 'org_admin', isOwner: true, status: 'active' }, requiresReason: true,
      }];
    }
    const actor = actorMemberships.get(req);
    if (!actor || actor.persona !== 'org_admin' || actor.status !== 'active' || actor.userId === target.userId) return [];
    const actions: MembershipAllowedAction[] = [];
    if (actor.isOwner) {
      if (target.persona === 'member') {
        actions.push({ id: 'promote_admin', label: '设为组织管理员', change: { persona: 'org_admin' }, requiresReason: false });
      } else if (target.isOwner) {
        actions.push({ id: 'revoke_owner', label: '撤销 Owner', change: { isOwner: false }, requiresReason: false });
      } else {
        actions.push(
          { id: 'grant_owner', label: '授予 Owner', change: { isOwner: true }, requiresReason: false },
          { id: 'demote_member', label: '降为成员', change: { persona: 'member' }, requiresReason: false },
        );
      }
    }
    if (target.persona === 'member' || actor.isOwner) {
      actions.push(target.status === 'active'
        ? { id: 'disable', label: '停用账号', change: { status: 'disabled' }, requiresReason: false }
        : { id: 'restore', label: '恢复账号', change: { status: 'active' }, requiresReason: false });
    }
    return actions;
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
    const requestedTenantId = personas.get(req) === 'platform_admin'
      ? (typeof req.query.tenantId === 'string'
          ? req.query.tenantId
          : typeof req.body?.tenantId === 'string'
            ? req.body.tenantId
            : req.path === '/tenants' && typeof req.body?.id === 'string' ? req.body.id : user.tenantId)
      : user.tenantId;
    const correlationId = `governance-access:${randomUUID()}`;
    const actorPersona = personas.get(req)!;
    const auditReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() || undefined : undefined;
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
          ? { effectiveAt: event.occurredAt, ...(body as Record<string, unknown>), changeId: intentAuditId, auditId: event.auditId }
          : { data: body, changeId: intentAuditId, auditId: event.auditId, effectiveAt: event.occurredAt };
        sendJson(payload);
      }).catch(async () => {
        let auditProjectionId: string | undefined;
        try {
          if (!deps.projectionOutbox) throw new Error('GOVERNANCE_AUDIT_OUTBOX_UNAVAILABLE');
          const projection = await deps.projectionOutbox.enqueue({
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
          });
          auditProjectionId = projection.outboxId;
        } catch {
          const changed = (body && typeof body === 'object' && !Array.isArray(body)
            && (body as Record<string, unknown>).changed === true) || res.statusCode < 400;
          const compensation = res.locals.governanceCompensation as {
            rollback: () => Promise<void>;
            failureBody: { code: string; error: string };
            rollbackFailureBody: { code: string; error: string };
          } | undefined;
          if (changed && compensation) {
            try {
              await compensation.rollback();
            } catch {
              res.statusCode = 500;
              sendJson({ ...compensation.rollbackFailureBody, changed: true });
              return;
            }
            res.statusCode = 500;
            sendJson(compensation.failureBody);
            return;
          }
          res.statusCode = 500;
          sendJson({
            code: 'GOVERNANCE_AUDIT_TERMINAL_NOT_DURABLE',
            error: changed ? '变更已执行，但终态审计未能持久化' : '请求失败且终态审计未能持久化',
            changed,
            auditId: intentAuditId,
          });
          return;
        }
        const payload = body && typeof body === 'object' && !Array.isArray(body)
          ? { ...(body as Record<string, unknown>), changeId: intentAuditId, auditId: intentAuditId, auditCompletion: 'pending', auditProjectionId }
          : { data: body, changeId: intentAuditId, auditId: intentAuditId, auditCompletion: 'pending', auditProjectionId };
        sendJson(payload);
      });
      return res;
    }) as typeof res.json;
    next();
  });

  registerGovernanceTenantSettingsRoutes(router, {
    personaFor: req => personas.get(req),
    tenantFor,
    getTenantSettings: deps.getTenantSettings,
    updateTenantSettings: deps.updateTenantSettings,
  });

  router.get('/projections/:projectionId', async (req, res) => {
    if (!canManageTenant(req) || !deps.projectionOutbox) return res.status(404).json({ error: 'Projection not found' });
    const projection = await deps.projectionOutbox.get(req.params.projectionId);
    if (!projection || tenantFor(req, projection.tenantId) !== projection.tenantId) {
      return res.status(404).json({ error: 'Projection not found' });
    }
    res.json(projection);
  });

  router.get('/oauth-grants', async (req, res) => {
    if (!deps.oauthGrants) {
      return res.status(503).json({ error: 'OAuth grant authority unavailable', code: 'OAUTH_GRANT_AUTHORITY_UNAVAILABLE' });
    }
    const tenantId = tenantFor(req);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    await deps.reconcileOAuthGrants?.(tenantId, req.user!.sub);
    return res.json({ grants: await deps.oauthGrants.listForSubject(tenantId, req.user!.sub) });
  });

  router.post('/memberships', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    if (!deps.createMember) return res.status(503).json({ error: 'Member creation authority unavailable', code: 'MEMBERSHIP_CREATION_AUTHORITY_UNAVAILABLE' });
    const parsed = membershipCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
    const requestedTenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    if (personas.get(req) === 'platform_admin' && requestedTenantId === undefined) return res.status(403).json({ error: 'Explicit customer tenant scope required', code: 'PLATFORM_RECOVERY_SCOPE_REQUIRED' });
    const tenantId = tenantFor(req, requestedTenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const debugModeError = deps.validateMemberDebugMode?.(tenantId, parsed.data.debugMode);
    if (debugModeError) return res.status(400).json({ error: debugModeError });
    if (tenantId === DEFAULT_TENANT_ID) return res.status(403).json({ error: 'Platform admins must use the platform-admin governance entry', code: 'PLATFORM_TENANT_MEMBERSHIP_FORBIDDEN' });
    if (parsed.data.role === 'admin' && personas.get(req) !== 'platform_admin' && !actorMemberships.get(req)?.isOwner) return res.status(403).json({ error: 'Only organization owners can create organization admins', code: 'MEMBERSHIP_CHANGE_FORBIDDEN' });
    try {
      const created = await deps.createMember({ ...parsed.data, tenantId, createdBy: req.user!.sub });
      res.status(201).json({
        userId: created.userId,
        membership: {
          ...created.membership,
          directoryProfile: deps.getMemberProfile?.(tenantId, created.userId) ?? null,
          allowedActions: membershipActionsFor(req, tenantId, created.membership),
        },
        changeId: res.locals.governanceChangeId,
        effectiveAt: created.membership.createdAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'Username already exists') {
        return res.status(409).json({ error: '用户名已存在', code: 'USERNAME_ALREADY_EXISTS' });
      }
      if (message === 'Tenant not found' || message === 'Tenant disabled') {
        return res.status(400).json({ error: message === 'Tenant disabled' ? '目标组织已禁用' : '目标组织不存在' });
      }
      const status = error instanceof MembershipInvariantError ? membershipErrorStatus(error) : 500;
      return res.status(status).json({
        error: message,
        ...(error instanceof MembershipInvariantError ? { code: error.code } : {}),
      });
    }
  });

  router.get('/memberships', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const memberships = await deps.memberships.listMemberships(tenantId);
    res.json({ memberships: memberships.map(membership => ({
      ...membership,
      directoryProfile: deps.getMemberProfile?.(tenantId, membership.userId) ?? null,
      allowedActions: membershipActionsFor(req, tenantId, membership),
    })) });
  });

  router.get('/memberships/:userId/details', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const membership = await deps.memberships.getMembership(tenantId, req.params.userId);
    if (!membership) return res.status(404).json({ error: 'Membership not found' });
    const profile = deps.getMemberProfile?.(tenantId, membership.userId);
    if (!profile) return res.status(503).json({ error: 'Member directory authority unavailable', code: 'MEMBER_DIRECTORY_AUTHORITY_UNAVAILABLE' });
    try {
      const assignments = await Promise.all(ASSIGNMENT_RESOURCE_TYPES.map(async resourceType => ({
        resourceType,
        resources: await deps.assignments.listEffectiveResourceIds(tenantId, membership.userId, resourceType),
      })));
      const usagePolicy = await getGovernanceMemberUsagePolicy(
        deps.getMemberBudgetOverview, tenantId, membership.userId,
      );
      const recentAudit = deps.audit.list
        ? (await deps.audit.list({ targetTenantId: tenantId, limit: 100 }))
          .filter(event => event.targetId.includes(`/memberships/${membership.userId}`))
        : [];
      res.json({
        profile,
        identity: { ...membership, allowedActions: membershipActionsFor(req, tenantId, membership) },
        accessSummary: {
          effectivePersona: membership.persona,
          owner: membership.isOwner,
          accountStatus: membership.status,
          decision: membership.status === 'active' ? 'eligible' : 'denied',
          why: [
            { source: 'membership', effect: membership.status === 'active' ? 'allow' : 'deny', version: membership.version },
            ...(membership.isOwner ? [{ source: 'organization_owner_invariant', effect: 'allow', version: membership.version }] : []),
          ],
        },
        assignments,
        usagePolicy,
        recentAudit: { events: recentAudit, coverage: 'recent_membership_endpoint_events', limit: 100 },
        snapshot: { membershipVersion: membership.version, generatedAt: now().toISOString() },
      });
    } catch (error) {
      res.status(503).json({
        error: 'Membership assignment projection unavailable',
        code: error instanceof Error ? error.message : 'ASSIGNMENT_PROJECTION_UNAVAILABLE',
      });
    }
  });

  router.post('/memberships/:userId/preview', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const parsed = membershipPreviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const requestedTenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    if (personas.get(req) === 'platform_admin' && requestedTenantId === undefined) return res.status(403).json({ error: 'Explicit customer tenant scope required', code: 'PLATFORM_RECOVERY_SCOPE_REQUIRED' });
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
        impact: {
          from: { persona: current.persona, isOwner: current.isOwner, status: current.status },
          to: {
            persona: parsed.data.persona ?? current.persona,
            isOwner: parsed.data.isOwner ?? current.isOwner,
            status: parsed.data.status ?? current.status,
          },
          blockers: [],
          reversible: true,
          effectiveMode: deps.projectionOutbox ? 'source_immediate_projection_pending' : 'source_immediate',
        },
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
    if (personas.get(req) === 'platform_admin' && requestedTenantId === undefined) return res.status(403).json({ error: 'Explicit customer tenant scope required', code: 'PLATFORM_RECOVERY_SCOPE_REQUIRED' });
    const tenantId = tenantFor(req, requestedTenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    let mutationApplied = false;
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
      mutationApplied = true;
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
      if (mutationApplied) {
        res.status(500).json({
          error: 'Membership 已更新，但兼容投影未能持久化',
          code: 'GOVERNANCE_PROJECTION_NOT_DURABLE',
          changed: true,
          changeId: res.locals.governanceChangeId,
        });
        return;
      }
      res.status(membershipErrorStatus(error)).json({
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof MembershipInvariantError ? { code: error.code } : {}),
      });
    }
  });

  router.get('/platform-admins', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const platformAdmins = await deps.memberships.listPlatformAdmins();
    res.json({ platformAdmins: platformAdmins.map(item => ({
      ...item, directoryProfile: deps.getPlatformAdminProfile?.(item.userId) ?? null,
    })) });
  });

  router.patch('/platform-admins/:userId', async (req, res) => {
    if (personas.get(req) !== 'platform_admin') return res.status(403).json({ error: 'Platform admin required' });
    const parsed = platformAdminPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    return res.status(503).json({
      error: 'Signed Platform Admin status authority unavailable',
      code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE',
    });
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

  if (deps.oauthGrants) {
    registerGovernanceOAuthGrantRoutes({
      router,
      grants: deps.oauthGrants,
      secret: deps.membershipPreviewSecret,
      previewTtlMs,
      now,
      tenantFor: req => tenantFor(req),
      ...(deps.revokeOAuthGrant ? { revokeExternal: deps.revokeOAuthGrant } : {}),
      ...(deps.resolveDependencyImpact ? { dependencyImpact: (grant: OAuthGrant) => oauthDependencyImpact(deps.resolveDependencyImpact!, grant) } : {}),
    });
  }

  registerGovernanceTenantLifecycleRoutes({
    router,
    secret: deps.membershipPreviewSecret,
    previewTtlMs,
    now,
    personaFor: req => personas.get(req),
    ...(deps.createTenant ? { createTenant: deps.createTenant } : {}),
    ...(deps.rollbackTenantCreate ? { rollbackTenantCreate: deps.rollbackTenantCreate } : {}),
    ...(deps.getTenantLifecycle ? { getTenant: deps.getTenantLifecycle } : {}),
    ...(deps.setTenantDisabled ? { setTenantDisabled: deps.setTenantDisabled } : {}),
    ...(deps.onTenantLifecycleChanged ? { onTenantLifecycleChanged: deps.onTenantLifecycleChanged } : {}),
    ...(deps.resolveDependencyImpact ? { dependencyImpact: (tenantId, action) => tenantDependencyImpact(deps.resolveDependencyImpact!, tenantId, action) } : {}),
  });

  router.get('/directory-groups', async (req, res) => {
    const tenantId = tenantFor(req, req.query.tenantId as string | undefined);
    if (!tenantId || !canManageTenant(req)) return res.status(403).json({ error: 'Organization admin required' });
    if (!deps.directoryGroups) {
      return res.status(503).json({ error: 'Directory group authority unavailable', code: 'DIRECTORY_GROUP_AUTHORITY_UNAVAILABLE' });
    }
    return res.json({ tenantId, groups: await deps.directoryGroups.listGroups(tenantId) });
  });

  registerGovernanceEntitlementRoutes({
    router,
    entitlements: deps.entitlements,
    secret: deps.membershipPreviewSecret,
    previewTtlMs,
    now,
    personaFor: req => personas.get(req),
    tenantFor,
    ...(deps.resolveEntitlementResource ? { resolveResource: deps.resolveEntitlementResource } : {}),
    ...(deps.listEntitlementResources ? { listResources: deps.listEntitlementResources } : {}),
    ...(deps.resolveDependencyImpact ? { dependencyImpact: input => entitlementDependencyImpact(deps.resolveDependencyImpact!, input) } : {}),
    ...(deps.projectionOutbox ? { projectionOutbox: deps.projectionOutbox } : {}),
    ...(deps.projectionReconciler ? { projectionReconciler: deps.projectionReconciler } : {}),
  });

  registerGovernanceOrganizationAccessRoutes({ router, assignments: deps.assignments, entitlements: deps.entitlements,
    secret: deps.membershipPreviewSecret, previewTtlMs, now, personaFor: req => personas.get(req), tenantFor,
    ...(deps.projectionOutbox ? { projectionOutbox: deps.projectionOutbox } : {}),
    ...(deps.projectionReconciler ? { projectionReconciler: deps.projectionReconciler } : {}),
  });
  registerGovernanceMemoryRoutes({ router, assignments: deps.assignments, entitlements: deps.entitlements, secret: deps.membershipPreviewSecret, previewTtlMs, now, personaFor: req => personas.get(req), tenantFor, validateSubjects: assignmentSubjectError, assignmentSnapshot: assignmentDirectorySnapshot });

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

  router.post('/assignments/:resourceType/:resourceId/preview', async (req, res) => {
    if (personas.get(req) !== 'org_admin') return res.status(403).json({ error: 'Organization admin required' });
    const resourceType = assignmentResourceTypeSchema.safeParse(req.params.resourceType);
    const parsed = assignmentPreviewSchema.safeParse(req.body);
    if (!resourceType.success || !parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const resourceError = await assignmentResourceError(tenantId, resourceType.data, req.params.resourceId);
    if (resourceError) return res.status(resourceError.status).json(resourceError.body);
    const subjectError = await assignmentSubjectError(tenantId, parsed.data.assignments);
    if (subjectError) return res.status(subjectError.status).json(subjectError.body);
    const current = await deps.assignments.getAssignmentSet(tenantId, resourceType.data, req.params.resourceId);
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== parsed.data.expectedVersion) {
      return res.status(409).json({ error: 'Assignment baseline version changed', code: 'ASSIGNMENT_PREVIEW_BASELINE_CONFLICT' });
    }
    let directorySnapshot: Record<string, unknown>;
    try {
      directorySnapshot = await assignmentDirectorySnapshot(tenantId, parsed.data.assignments);
    } catch {
      return res.status(503).json({ error: 'Directory authority unavailable or stale', code: 'DIRECTORY_GROUP_AUTHORITY_STALE' });
    }
    const baselineDigest = governanceDigest({
      assignment: assignmentBaseline(tenantId, resourceType.data, req.params.resourceId, current),
      directorySnapshot,
    });
    const expiresAt = new Date(now().getTime() + previewTtlMs).toISOString();
    const signatureInput = {
      version: 1,
      actorUserId: req.user!.sub,
      actorTenantId: req.user!.tenantId,
      tenantId,
      resourceType: resourceType.data,
      resourceId: req.params.resourceId,
      expectedVersion: parsed.data.expectedVersion,
      baselineDigest,
      expiresAt,
      changeDigest: governanceDigest(parsed.data),
    };
    return res.json({
      previewId: `apv1.${previewSignature(deps.membershipPreviewSecret, signatureInput)}`,
      baselineDigest,
      expiresAt,
      expectedVersion: parsed.data.expectedVersion,
      impact: { assignmentCount: parsed.data.assignments.length, createsAssignmentSet: current === null },
      changeId: res.locals.governanceChangeId,
    });
  });

  router.put('/assignments/:resourceType/:resourceId', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    if (personas.get(req) === 'platform_admin') {
      return res.status(403).json({ error: 'Platform administrators cannot mutate customer assignments', code: 'PLATFORM_ASSIGNMENT_WRITE_FORBIDDEN' });
    }
    const resourceType = assignmentResourceTypeSchema.safeParse(req.params.resourceType);
    const parsed = assignmentPatchSchema.safeParse(req.body);
    if (!resourceType.success || !parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const { previewId, baselineDigest, expiresAt, ...mutation } = parsed.data;
    if (Date.parse(expiresAt) <= now().getTime()) {
      return res.status(409).json({ error: 'Assignment preview expired', code: 'ASSIGNMENT_PREVIEW_EXPIRED' });
    }
    const expectedPreviewId = `apv1.${previewSignature(deps.membershipPreviewSecret, {
      version: 1,
      actorUserId: req.user!.sub,
      actorTenantId: req.user!.tenantId,
      tenantId,
      resourceType: resourceType.data,
      resourceId: req.params.resourceId,
      expectedVersion: mutation.expectedVersion,
      baselineDigest,
      expiresAt,
      changeDigest: governanceDigest(mutation),
    })}`;
    if (!previewMatches(previewId, expectedPreviewId)) {
      return res.status(409).json({ error: 'Assignment preview invalid', code: 'ASSIGNMENT_PREVIEW_INVALID' });
    }
    const current = await deps.assignments.getAssignmentSet(tenantId, resourceType.data, req.params.resourceId);
    let directorySnapshot: Record<string, unknown>;
    try {
      directorySnapshot = await assignmentDirectorySnapshot(tenantId, mutation.assignments);
    } catch {
      return res.status(503).json({ error: 'Directory authority unavailable or stale', code: 'DIRECTORY_GROUP_AUTHORITY_STALE' });
    }
    const currentBaselineDigest = governanceDigest({
      assignment: assignmentBaseline(tenantId, resourceType.data, req.params.resourceId, current),
      directorySnapshot,
    });
    if ((current?.version ?? 0) !== mutation.expectedVersion || currentBaselineDigest !== baselineDigest) {
      return res.status(409).json({ error: 'Assignment preview baseline changed', code: 'ASSIGNMENT_PREVIEW_BASELINE_CONFLICT' });
    }
    const resourceError = await assignmentResourceError(tenantId, resourceType.data, req.params.resourceId);
    if (resourceError) return res.status(resourceError.status).json(resourceError.body);
    const subjectError = await assignmentSubjectError(tenantId, mutation.assignments);
    if (subjectError) return res.status(subjectError.status).json(subjectError.body);
    try {
      const assignmentSet = await deps.assignments.replaceAssignments(
        tenantId, resourceType.data, req.params.resourceId,
        mutation.assignments, mutation.expectedVersion, req.user!.sub,
      );
      let projectionId: string | undefined;
      if (deps.projectionOutbox) {
        try {
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
        } catch {
          return res.status(500).json({
            error: 'Assignment 已更新，但兼容投影未能持久化',
            code: 'GOVERNANCE_PROJECTION_NOT_DURABLE', changed: true,
            changeId: res.locals.governanceChangeId,
          });
        }
      }
      res.json({
        ...assignmentSet,
        changeId: res.locals.governanceChangeId,
        effectiveAt: assignmentSet.updatedAt ?? now().toISOString(),
        projectionStatus: deps.projectionOutbox ? 'pending' : 'not_configured',
        compatibilityProjection: deps.projectionOutbox ? 'applied_with_projection_pending' : 'not_configured',
        ...(projectionId ? { projectionId } : {}),
      });
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
    return res.status(503).json({
      error: 'Signed Content Access Grant authority unavailable',
      code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE',
    });
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
    return res.status(503).json({
      error: 'Signed Content Access Grant revocation authority unavailable',
      code: 'GOVERNANCE_PREVIEW_AUTHORITY_UNAVAILABLE',
    });
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
