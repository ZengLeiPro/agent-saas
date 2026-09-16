import type { NextFunction, Request, Response } from 'express';

import { isPlatformAdmin } from '../auth/types.js';
import type { PlatformDemoCapabilityStore } from './capabilityStore.js';
import { PLATFORM_DEMO_CAPABILITY } from './types.js';

const PRODUCTION_ADMIN_WRITE_PREFIXES = [
  '/api/admin',
  '/api/governance',
] as const;

/**
 * Defense-in-depth: org admins with platform_demo_access must never mutate
 * production platform/admin surfaces. requirePlatformAdmin already 403s most
 * /api/admin routes; this guard covers write verbs on admin/governance paths
 * for demo-capable identities and makes the contract explicit in tests.
 */
export function createRejectPlatformDemoProductionWrites(deps: {
  capabilities: PlatformDemoCapabilityStore;
  /** Optional override for path matching in tests. */
  isProductionAdminPath?: (path: string) => boolean;
}): (req: Request, res: Response, next: NextFunction) => void {
  const isProductionAdminPath = deps.isProductionAdminPath ?? ((path: string) =>
    PRODUCTION_ADMIN_WRITE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)));

  return (req, res, next) => {
    void (async () => {
      try {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
        if (!isProductionAdminPath(req.path) && !isProductionAdminPath(req.originalUrl.split('?')[0] ?? '')) {
          return next();
        }
        const actor = req.user;
        if (!actor || isPlatformAdmin(actor)) return next();

        const grant = await deps.capabilities.getGrant(
          actor.tenantId,
          actor.sub,
          PLATFORM_DEMO_CAPABILITY,
        );
        if (!grant) return next();

        return res.status(403).json({
          error: '演示身份不能写入生产平台管理接口',
          code: 'PLATFORM_DEMO_PRODUCTION_WRITE_FORBIDDEN',
        });
      } catch {
        return res.status(503).json({
          error: 'Platform demo authority unavailable',
          code: 'PLATFORM_DEMO_AUTHORITY_UNAVAILABLE',
        });
      }
    })();
  };
}

/** Pure helper for unit tests without Express. */
export async function assertDemoIdentityBlockedFromProductionWrite(input: {
  method: string;
  path: string;
  actor: { sub: string; tenantId: string; role: 'admin' | 'user' } | undefined;
  isPlatformAdmin: boolean;
  hasDemoGrant: boolean;
}): Promise<{ allowed: boolean; code?: string }> {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method)) {
    return { allowed: true };
  }
  const isAdminPath = PRODUCTION_ADMIN_WRITE_PREFIXES.some(
    (prefix) => input.path === prefix || input.path.startsWith(`${prefix}/`),
  );
  if (!isAdminPath) return { allowed: true };
  if (!input.actor || input.isPlatformAdmin) return { allowed: true };
  if (!input.hasDemoGrant) return { allowed: true };
  return { allowed: false, code: 'PLATFORM_DEMO_PRODUCTION_WRITE_FORBIDDEN' };
}
