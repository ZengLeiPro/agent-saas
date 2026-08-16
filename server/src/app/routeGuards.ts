import type { NextFunction, Request, Response } from "express";

import type { TenantStore } from "../data/tenants/store.js";
import type { AppRuntime } from "./runtime.js";

export function activeOffboardingWriteFence(runtime: AppRuntime) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (!runtime.governanceChangeJobStore) {
      res.status(503).json({
        error: 'Offboarding authority unavailable',
        code: 'OFFBOARDING_AUTHORITY_UNAVAILABLE',
      });
      return;
    }
    try {
      const job = await runtime.governanceChangeJobStore.findActiveForTarget(
        req.user.tenantId, 'user_offboarding', 'user', req.user.sub,
      );
      if (job) {
        res.status(409).json({ error: 'User offboarding is in progress', code: 'USER_OFFBOARDING_ACTIVE' });
        return;
      }
      next();
    } catch {
      res.status(503).json({
        error: 'Offboarding authority unavailable',
        code: 'OFFBOARDING_AUTHORITY_UNAVAILABLE',
      });
    }
  };
}

export function tenantFeatureGuard(
  tenantStore: TenantStore | undefined,
  feature:
    | "filesEnabled"
    | "cronEnabled"
    | "mcpEnabled"
    | "customSkillsEnabled"
    | "kbEnabled",
  label: string,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!tenantStore || !req.user?.tenantId) {
      next();
      return;
    }
    const settings = tenantStore.getSettings(req.user.tenantId);
    if (settings && settings.features[feature] === false) {
      res.status(403).json({
        error: `${label} 已被当前组织禁用`,
        code: "TENANT_FEATURE_DISABLED",
      });
      return;
    }
    next();
  };
}
