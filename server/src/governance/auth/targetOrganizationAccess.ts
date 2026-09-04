import type { Request, RequestHandler } from 'express';

import type { PgMembershipStore, TenantMembership } from '../../data/memberships/index.js';
import { DEFAULT_TENANT_ID } from '../../data/tenants/types.js';
import { isActivePlatformAdminIdentity } from '../subject/platformIdentity.js';

export type TargetOrganizationActorPersona = 'platform_admin' | 'org_admin' | 'member';
export type TargetOrganizationAccessMode =
  'platform_manage' | 'organization_manage' | 'effective_only';

export interface TargetOrganizationAccess {
  actorUserId: string;
  actorTenantId: string;
  actorPersona: TargetOrganizationActorPersona;
  targetTenantId: string;
  accessMode: TargetOrganizationAccessMode;
}

export class TargetOrganizationAccessError extends Error {
  constructor(
    readonly code:
      'TARGET_TENANT_REQUIRED' | 'TARGET_ORGANIZATION_FORBIDDEN' | 'TARGET_ORGANIZATION_NOT_FOUND',
    readonly status: 403 | 404,
  ) {
    super(code);
    this.name = 'TargetOrganizationAccessError';
  }
}

export interface TargetOrganizationAccessAuthorities {
  memberships: Pick<PgMembershipStore, 'getPlatformAdmin' | 'getMembership'>;
  tenantExists?: (tenantId: string) => boolean | Promise<boolean>;
}

export function requestedTenantId(req: Request): string | undefined {
  return typeof req.query.tenantId === 'string'
    ? req.query.tenantId
    : typeof req.body?.tenantId === 'string'
      ? req.body.tenantId
      : typeof req.params?.tenantId === 'string'
        ? req.params.tenantId
        : undefined;
}

export function governedTenantFor(
  req: Request,
  persona: TargetOrganizationActorPersona | undefined,
  access: TargetOrganizationAccess | undefined,
  requested: string | undefined,
  tenantExists?: (tenantId: string) => boolean,
  allowPlatformActorTenant = false,
): string | null {
  if (requested && access?.targetTenantId === requested) return requested;
  if (persona === 'platform_admin') {
    if (!requested) return allowPlatformActorTenant ? (req.user?.tenantId ?? null) : null;
    return requested === DEFAULT_TENANT_ID || tenantExists?.(requested) === false
      ? null
      : requested;
  }
  if (!req.user?.tenantId || (requested && requested !== req.user.tenantId)) return null;
  return req.user.tenantId;
}

export function createTargetOrganizationAccessGuard(
  authorities: TargetOrganizationAccessAuthorities,
  targetFor: (req: Request) => string | undefined = requestedTenantId,
): {
  get: (req: Request) => TargetOrganizationAccess | undefined;
  middleware: RequestHandler;
} {
  const accesses = new WeakMap<Request, TargetOrganizationAccess>();
  return {
    get: (req) => accesses.get(req),
    middleware: async (req, res, next) => {
      const targetTenantId = targetFor(req);
      if (!targetTenantId) return next();
      try {
        accesses.set(
          req,
          await resolveTargetOrganizationAccess(
            req,
            targetTenantId,
            ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? 'manage' : 'read',
            authorities,
          ),
        );
        return next();
      } catch (error) {
        const accessError = targetOrganizationAccessErrorBody(error);
        if (accessError) return res.status(accessError.status).json(accessError.body);
        return res.status(503).json({ error: 'Target organization authority unavailable' });
      }
    },
  };
}

/**
 * Resolves actor identity and target-organization authority from live governance stores.
 * Platform administrators never need (and must never receive) a synthetic target Membership.
 */
export async function resolveTargetOrganizationAccess(
  req: Request,
  targetTenantId: string | undefined,
  required: 'read' | 'manage',
  authorities: TargetOrganizationAccessAuthorities,
): Promise<TargetOrganizationAccess> {
  const actor = req.user;
  if (!actor) throw new TargetOrganizationAccessError('TARGET_ORGANIZATION_FORBIDDEN', 403);

  const platformAdmin = await authorities.memberships.getPlatformAdmin(actor.sub);
  if (isActivePlatformAdminIdentity(actor.tenantId, platformAdmin)) {
    if (!targetTenantId) throw new TargetOrganizationAccessError('TARGET_TENANT_REQUIRED', 403);
    await assertCustomerTenant(targetTenantId, authorities.tenantExists);
    return {
      actorUserId: actor.sub,
      actorTenantId: actor.tenantId,
      actorPersona: 'platform_admin',
      targetTenantId,
      accessMode: 'platform_manage',
    };
  }

  const membership = await authorities.memberships.getMembership(actor.tenantId, actor.sub);
  return resolveTargetOrganizationAccessForIdentity(
    req,
    targetTenantId,
    required,
    membership,
    authorities.tenantExists,
  );
}

/** Reuses an identity already resolved from the same live stores by a router middleware. */
export async function resolveTargetOrganizationAccessForIdentity(
  req: Request,
  targetTenantId: string | undefined,
  required: 'read' | 'manage',
  membership: TenantMembership | null | undefined,
  tenantExists?: TargetOrganizationAccessAuthorities['tenantExists'],
  platformAdmin = false,
): Promise<TargetOrganizationAccess> {
  const actor = req.user;
  if (!actor) throw new TargetOrganizationAccessError('TARGET_ORGANIZATION_FORBIDDEN', 403);

  if (platformAdmin) {
    if (!targetTenantId) throw new TargetOrganizationAccessError('TARGET_TENANT_REQUIRED', 403);
    await assertCustomerTenant(targetTenantId, tenantExists);
    return {
      actorUserId: actor.sub,
      actorTenantId: actor.tenantId,
      actorPersona: 'platform_admin',
      targetTenantId,
      accessMode: 'platform_manage',
    };
  }

  if (
    !membership ||
    membership.tenantId !== actor.tenantId ||
    membership.userId !== actor.sub ||
    membership.status !== 'active'
  ) {
    throw new TargetOrganizationAccessError('TARGET_ORGANIZATION_FORBIDDEN', 403);
  }
  const target = targetTenantId ?? actor.tenantId;
  if (target !== actor.tenantId || target === DEFAULT_TENANT_ID) {
    throw new TargetOrganizationAccessError('TARGET_ORGANIZATION_FORBIDDEN', 403);
  }
  await assertCustomerTenant(target, tenantExists);
  if (membership.persona === 'org_admin') {
    return {
      actorUserId: actor.sub,
      actorTenantId: actor.tenantId,
      actorPersona: 'org_admin',
      targetTenantId: target,
      accessMode: 'organization_manage',
    };
  }
  if (required === 'manage') {
    throw new TargetOrganizationAccessError('TARGET_ORGANIZATION_FORBIDDEN', 403);
  }
  return {
    actorUserId: actor.sub,
    actorTenantId: actor.tenantId,
    actorPersona: 'member',
    targetTenantId: target,
    accessMode: 'effective_only',
  };
}

export function targetOrganizationAccessErrorBody(error: unknown): {
  status: 403 | 404;
  body: { error: string; code: string };
} | null {
  if (!(error instanceof TargetOrganizationAccessError)) return null;
  const message =
    error.code === 'TARGET_TENANT_REQUIRED'
      ? 'Explicit target organization is required'
      : error.code === 'TARGET_ORGANIZATION_NOT_FOUND'
        ? 'Target organization not found'
        : 'Target organization access denied';
  return { status: error.status, body: { error: message, code: error.code } };
}

async function assertCustomerTenant(
  tenantId: string,
  tenantExists?: TargetOrganizationAccessAuthorities['tenantExists'],
): Promise<void> {
  if (!tenantId.trim() || tenantId === DEFAULT_TENANT_ID) {
    throw new TargetOrganizationAccessError('TARGET_ORGANIZATION_FORBIDDEN', 403);
  }
  if (tenantExists && !(await tenantExists(tenantId))) {
    throw new TargetOrganizationAccessError('TARGET_ORGANIZATION_NOT_FOUND', 404);
  }
}
