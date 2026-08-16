import type { Request, Router } from 'express';
import { z } from 'zod';

import type { TenantMemoryFeatureStatusMap } from '../../../shared/src/types/tenant.js';
import type { TenantSettings } from '../data/tenants/types.js';
import type { GovernancePersona } from './governanceAccessValidation.js';
import {
  tenantSettingsPolicyError,
  tenantSettingsSchema,
  type TenantSettingsPatch,
} from './tenantSettingsValidation.js';

const mutationSchema = z.object({
  settings: tenantSettingsSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();

type TenantSettingsView = {
  settings: TenantSettings;
  updatedAt: string;
  memoryFeatureStatus?: TenantMemoryFeatureStatusMap;
};

export interface GovernanceTenantSettingsRoutesOptions {
  personaFor(req: Request): GovernancePersona | undefined;
  tenantFor(req: Request, requested?: string): string | null;
  getTenantSettings?: (tenantId: string) => TenantSettingsView | undefined;
  updateTenantSettings?: (
    tenantId: string,
    settings: TenantSettingsPatch,
    expectedUpdatedAt: string,
  ) => Promise<TenantSettingsView>;
}

export function registerGovernanceTenantSettingsRoutes(
  router: Router,
  options: GovernanceTenantSettingsRoutesOptions,
): void {
  const canManageTenant = (req: Request) => {
    const persona = options.personaFor(req);
    return persona === 'platform_admin' || persona === 'org_admin';
  };

  router.get('/tenant-settings', (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const requestedTenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    const tenantId = options.tenantFor(req, requestedTenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (!options.getTenantSettings) return res.status(503).json({ error: 'Tenant settings authority unavailable' });
    const result = options.getTenantSettings(tenantId);
    if (!result) return res.status(404).json({ error: '组织不存在' });
    return res.json({ tenantId, ...result });
  });

  router.put('/tenant-settings', async (req, res) => {
    if (!canManageTenant(req)) return res.status(403).json({ error: 'Admin required' });
    const requestedTenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    const tenantId = options.tenantFor(req, requestedTenantId);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    if (!options.getTenantSettings || !options.updateTenantSettings) {
      return res.status(503).json({ error: 'Tenant settings authority unavailable' });
    }
    const parsed = mutationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]!.message });
    const current = options.getTenantSettings(tenantId);
    if (!current) return res.status(404).json({ error: '组织不存在' });
    if (current.updatedAt !== parsed.data.expectedUpdatedAt) {
      return res.status(409).json({
        error: '组织设置已被其他操作更新，请刷新后重试',
        code: 'TENANT_SETTINGS_BASELINE_CONFLICT',
      });
    }
    const policyError = tenantSettingsPolicyError(
      parsed.data.settings,
      current.settings,
      options.personaFor(req) === 'platform_admin',
    );
    if (policyError) return res.status(policyError.status).json({ error: policyError.error });
    try {
      const result = await options.updateTenantSettings(
        tenantId,
        parsed.data.settings,
        parsed.data.expectedUpdatedAt,
      );
      return res.json({ tenantId, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'Tenant not found') return res.status(404).json({ error: '组织不存在' });
      if (message === 'Tenant settings baseline changed') {
        return res.status(409).json({
          error: '组织设置已被其他操作更新，请刷新后重试',
          code: 'TENANT_SETTINGS_BASELINE_CONFLICT',
        });
      }
      return res.status(400).json({ error: message });
    }
  });
}
