import { Router } from 'express';
import { z } from 'zod';

import type { GovernanceAuditStore } from '../data/governance-audit/index.js';
import type { PgMembershipStore } from '../data/memberships/index.js';
import {
  GovernanceMigrationControlInvariantError,
  type PgGovernanceMigrationControlStore,
} from '../data/migrationControl/index.js';
import { isActivePlatformAdminIdentity } from '../governance/subject/platformIdentity.js';

const settingsSchema = z.object({
  expectedRevision: z.number().int().positive(),
  writeAuthority: z.enum(['legacy', 'dual', 'governance']),
  legacyWritesSealed: z.boolean(),
  compatibilityProjectionEnabled: z.boolean(),
  rollbackEnabled: z.boolean(),
  reason: z.string().min(3).max(500),
}).strict();

const transitionSchema = z.object({
  expectedRevision: z.number().int().positive(),
  mode: z.enum(['shadow', 'enforce', 'rollback']),
  reason: z.string().min(3).max(500),
}).strict();

const resolveDifferenceSchema = z.object({
  accept: z.boolean(),
  reason: z.string().min(3).max(500),
}).strict();

function errorStatus(error: unknown): number {
  if (!(error instanceof GovernanceMigrationControlInvariantError)) return 500;
  if (error.code.includes('VERSION_CONFLICT')) return 409;
  if (error.code === 'MIGRATION_DIFFERENCE_NOT_FOUND' || error.code === 'MIGRATION_CONTROL_NOT_FOUND') return 404;
  return 422;
}

export function createGovernanceMigrationRouter(deps: {
  store: PgGovernanceMigrationControlStore;
  memberships: PgMembershipStore;
  audit: GovernanceAuditStore;
}): Router {
  const router = Router();

  router.use(async (req, res, next) => {
    if (!req.user?.sub) return res.status(401).json({ error: 'Unauthorized' });
    const platformAdmin = await deps.memberships.getPlatformAdmin(req.user.sub);
    if (!isActivePlatformAdminIdentity(req.user.tenantId, platformAdmin)) {
      return res.status(403).json({ error: '仅平台管理员可操作治理迁移门禁', code: 'PLATFORM_ADMIN_REQUIRED' });
    }
    next();
  });

  router.get('/', async (_req, res) => {
    try {
      const [control, domains, differences] = await Promise.all([
        deps.store.getControl(), deps.store.listDomains(), deps.store.listDifferences({ status: 'open' }),
      ]);
      res.json({ control, domains, openDifferences: differences });
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/settings', async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const actor = req.user!;
    try {
      const intent = await deps.audit.append({
        correlationId: `migration-settings:${parsed.data.expectedRevision}`,
        actorType: 'user', actorUserId: actor.sub, actorPersona: 'platform_admin',
        actorTenantId: actor.tenantId, action: 'governance.migration.settings.update',
        targetType: 'governance_migration_control', targetId: 'global', purpose: parsed.data.reason,
        result: 'intent', metadata: { expectedRevision: parsed.data.expectedRevision },
      });
      const control = await deps.store.updateSettings({ ...parsed.data, updatedBy: actor.sub });
      const receipt = await deps.audit.append({
        correlationId: `migration-settings:${parsed.data.expectedRevision}`,
        actorType: 'user', actorUserId: actor.sub, actorPersona: 'platform_admin',
        actorTenantId: actor.tenantId, action: 'governance.migration.settings.update',
        targetType: 'governance_migration_control', targetId: 'global', purpose: parsed.data.reason,
        result: 'succeeded', metadata: { revision: control.revision, writeAuthority: control.writeAuthority },
      }).catch(() => null);
      res.json({
        ...control,
        auditId: receipt?.auditId ?? intent.auditId,
        ...(!receipt ? { auditCompletion: 'pending' } : {}),
      });
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/differences/:id/resolve', async (req, res) => {
    const parsed = resolveDifferenceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const actor = req.user!;
    const correlationId = `migration-difference:${req.params.id}`;
    try {
      const intent = await deps.audit.append({
        correlationId, actorType: 'user', actorUserId: actor.sub, actorPersona: 'platform_admin',
        actorTenantId: actor.tenantId, action: 'governance.migration.difference.resolve',
        targetType: 'governance_shadow_difference', targetId: req.params.id,
        purpose: 'shadow difference disposition', reason: parsed.data.reason,
        result: 'intent', metadata: { accepted: parsed.data.accept },
      });
      const difference = await deps.store.resolveDifference(
        req.params.id, actor.sub, parsed.data.reason, parsed.data.accept,
      );
      const receipt = await deps.audit.append({
        correlationId, actorType: 'user', actorUserId: actor.sub, actorPersona: 'platform_admin',
        actorTenantId: actor.tenantId, action: 'governance.migration.difference.resolve',
        targetType: 'governance_shadow_difference', targetId: req.params.id,
        purpose: 'shadow difference disposition', reason: parsed.data.reason,
        result: 'succeeded', metadata: { accepted: parsed.data.accept },
      }).catch(() => null);
      res.json({
        ...difference,
        auditId: receipt?.auditId ?? intent.auditId,
        ...(!receipt ? { auditCompletion: 'pending' } : {}),
      });
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/transition', async (req, res) => {
    const parsed = transitionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const actor = req.user!;
    try {
      const intent = await deps.audit.append({
        correlationId: `migration-transition:${parsed.data.expectedRevision}`,
        actorType: 'user', actorUserId: actor.sub, actorPersona: 'platform_admin',
        actorTenantId: actor.tenantId, action: 'governance.migration.transition',
        targetType: 'governance_migration_control', targetId: 'global', purpose: parsed.data.reason,
        result: 'intent', metadata: { expectedRevision: parsed.data.expectedRevision, mode: parsed.data.mode },
      });
      const control = await deps.store.transitionMode({ ...parsed.data, updatedBy: actor.sub });
      const receipt = await deps.audit.append({
        correlationId: `migration-transition:${parsed.data.expectedRevision}`,
        actorType: 'user', actorUserId: actor.sub, actorPersona: 'platform_admin',
        actorTenantId: actor.tenantId, action: 'governance.migration.transition',
        targetType: 'governance_migration_control', targetId: 'global', purpose: parsed.data.reason,
        result: 'succeeded', metadata: { revision: control.revision, mode: control.mode },
      }).catch(() => null);
      res.json({
        ...control,
        auditId: receipt?.auditId ?? intent.auditId,
        ...(!receipt ? { auditCompletion: 'pending' } : {}),
      });
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
