import type { Request } from 'express';

import { isPlatformAdmin } from '../auth/types.js';
import type { TenantMembership } from '../data/memberships/types.js';
import type { PlatformDemoCapabilityStore } from './capabilityStore.js';
import {
  isPlatformDemoFeatureEnabled,
  PLATFORM_DEMO_CAPABILITY,
  type PlatformDemoAccess,
} from './types.js';

export class PlatformDemoAccessError extends Error {
  constructor(
    readonly code:
      | 'PLATFORM_DEMO_DISABLED'
      | 'PLATFORM_DEMO_FORBIDDEN'
      | 'PLATFORM_DEMO_ORG_ADMIN_REQUIRED'
      | 'PLATFORM_ADMIN_REQUIRED',
    readonly status: 403,
  ) {
    super(code);
    this.name = 'PlatformDemoAccessError';
  }
}

export interface PlatformDemoAuthDeps {
  capabilities: PlatformDemoCapabilityStore;
  getMembership(tenantId: string, userId: string): Promise<TenantMembership | null>;
  featureEnabled?: () => boolean;
}

export async function resolvePlatformDemoAccess(
  req: Request,
  deps: PlatformDemoAuthDeps,
): Promise<PlatformDemoAccess> {
  const actor = req.user;
  if (!actor) throw new PlatformDemoAccessError('PLATFORM_DEMO_FORBIDDEN', 403);
  if (!(deps.featureEnabled ?? isPlatformDemoFeatureEnabled)()) {
    throw new PlatformDemoAccessError('PLATFORM_DEMO_DISABLED', 403);
  }
  // Platform admins manage real platform settings; demo shell is for granted org admins.
  if (isPlatformAdmin(actor)) {
    throw new PlatformDemoAccessError('PLATFORM_DEMO_FORBIDDEN', 403);
  }

  const membership = await deps.getMembership(actor.tenantId, actor.sub);
  if (
    !membership
    || membership.status !== 'active'
    || membership.persona !== 'org_admin'
    || membership.tenantId !== actor.tenantId
    || membership.userId !== actor.sub
  ) {
    throw new PlatformDemoAccessError('PLATFORM_DEMO_ORG_ADMIN_REQUIRED', 403);
  }

  const grant = await deps.capabilities.getGrant(actor.tenantId, actor.sub, PLATFORM_DEMO_CAPABILITY);
  if (!grant) throw new PlatformDemoAccessError('PLATFORM_DEMO_FORBIDDEN', 403);

  return {
    actorUserId: actor.sub,
    actorTenantId: actor.tenantId,
    actorPersona: 'platform_demo',
    accessMode: 'platform_demo',
    capability: PLATFORM_DEMO_CAPABILITY,
  };
}

export async function assertPlatformAdminCanManageDemoGrants(req: Request): Promise<void> {
  if (!isPlatformAdmin(req.user)) {
    throw new PlatformDemoAccessError('PLATFORM_ADMIN_REQUIRED', 403);
  }
}

export function platformDemoAccessErrorBody(error: unknown): {
  status: 403;
  body: { error: string; code: string };
} | null {
  if (!(error instanceof PlatformDemoAccessError)) return null;
  const message =
    error.code === 'PLATFORM_DEMO_DISABLED'
      ? '平台演示模式已关闭'
      : error.code === 'PLATFORM_ADMIN_REQUIRED'
        ? '仅平台管理员可授予或撤销演示权限'
        : error.code === 'PLATFORM_DEMO_ORG_ADMIN_REQUIRED'
          ? '仅组织管理员可进入平台演示模式'
          : '当前账号没有平台演示权限';
  return { status: 403, body: { error: message, code: error.code } };
}
