import type { Request } from 'express';

import { isPlatformAdmin } from '../auth/middleware.js';

export function tenantFor(req: Request, requested?: string): string | null {
  if (!req.user) return null;
  if (isPlatformAdmin(req.user)) return requested ?? queryTenant(req) ?? null;
  if (requested && requested !== req.user.tenantId) return null;
  return req.user.tenantId;
}

export function queryTenant(req: Request): string | undefined {
  return typeof req.query.tenantId === 'string' && req.query.tenantId.trim()
    ? req.query.tenantId.trim()
    : undefined;
}
