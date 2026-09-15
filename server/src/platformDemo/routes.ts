import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';

import { isPlatformAdmin } from '../auth/types.js';
import type { GovernanceAuditStore } from '../data/governance-audit/types.js';
import type { TenantMembership } from '../data/memberships/types.js';
import {
  assertPlatformAdminCanManageDemoGrants,
  platformDemoAccessErrorBody,
  resolvePlatformDemoAccess,
  type PlatformDemoAuthDeps,
} from './auth.js';
import type { PlatformDemoCapabilityStore } from './capabilityStore.js';
import type { PlatformDemoSessionStore } from './demoSessionStore.js';
import {
  platformDemoAnalyticsFixture,
  platformDemoConfigFixture,
  platformDemoConfigFixtures,
} from './fixtures.js';
import {
  PLATFORM_DEMO_BANNER,
  PLATFORM_DEMO_CAPABILITY,
  PLATFORM_DEMO_MENU_LABEL,
  isPlatformDemoFeatureEnabled,
} from './types.js';

const grantBodySchema = z.object({
  tenantId: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
}).strict();

const saveBodySchema = z.object({
  sectionId: z.string().min(1).max(64),
  draft: z.record(z.string(), z.unknown()),
}).strict();

export interface PlatformDemoRouterDeps {
  capabilities: PlatformDemoCapabilityStore;
  sessions: PlatformDemoSessionStore;
  getMembership(tenantId: string, userId: string): Promise<TenantMembership | null>;
  audit?: GovernanceAuditStore;
  featureEnabled?: () => boolean;
  now?: () => Date;
}

async function appendDemoAudit(
  audit: GovernanceAuditStore | undefined,
  input: Parameters<GovernanceAuditStore['append']>[0],
): Promise<void> {
  if (!audit) return;
  try {
    await audit.append(input);
  } catch {
    // Light audit: do not fail demo reads/saves if audit is unavailable.
  }
}

export function createPlatformDemoRouter(deps: PlatformDemoRouterDeps): Router {
  const router = Router();
  const authDeps: PlatformDemoAuthDeps = {
    capabilities: deps.capabilities,
    getMembership: deps.getMembership,
    featureEnabled: deps.featureEnabled ?? isPlatformDemoFeatureEnabled,
  };
  const now = () => deps.now?.() ?? new Date();

  const requireDemoAccess: RequestHandler = async (req, res, next) => {
    try {
      const access = await resolvePlatformDemoAccess(req, authDeps);
      (req as Request & { platformDemoAccess?: typeof access }).platformDemoAccess = access;
      return next();
    } catch (error) {
      const body = platformDemoAccessErrorBody(error);
      if (body) return res.status(body.status).json(body.body);
      return res.status(503).json({ error: 'Platform demo authority unavailable' });
    }
  };

  router.get('/access', async (req, res) => {
    const featureEnabled = (deps.featureEnabled ?? isPlatformDemoFeatureEnabled)();
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (isPlatformAdmin(req.user)) {
      return res.json({
        allowed: false,
        featureEnabled,
        reasonCode: 'PLATFORM_ADMIN_USES_REAL_SHELL',
        banner: PLATFORM_DEMO_BANNER,
        menuLabel: PLATFORM_DEMO_MENU_LABEL,
      });
    }
    try {
      await resolvePlatformDemoAccess(req, authDeps);
      return res.json({
        allowed: true,
        featureEnabled,
        reasonCode: 'PLATFORM_DEMO_ALLOWED',
        banner: PLATFORM_DEMO_BANNER,
        menuLabel: PLATFORM_DEMO_MENU_LABEL,
        actorPersona: 'platform_demo',
        accessMode: 'platform_demo',
      });
    } catch (error) {
      const body = platformDemoAccessErrorBody(error);
      return res.json({
        allowed: false,
        featureEnabled,
        reasonCode: body?.body.code ?? 'PLATFORM_DEMO_FORBIDDEN',
        banner: PLATFORM_DEMO_BANNER,
        menuLabel: PLATFORM_DEMO_MENU_LABEL,
      });
    }
  });

  router.post('/enter', requireDemoAccess, async (req, res) => {
    const access = (req as Request & { platformDemoAccess: Awaited<ReturnType<typeof resolvePlatformDemoAccess>> })
      .platformDemoAccess;
    await appendDemoAudit(deps.audit, {
      correlationId: `platform-demo-enter:${access.actorUserId}`,
      actorType: 'user',
      actorUserId: access.actorUserId,
      actorPersona: 'platform_demo',
      actorTenantId: access.actorTenantId,
      action: 'platform_demo.enter',
      targetType: 'platform_demo_session',
      targetId: access.actorUserId,
      purpose: 'enter platform demo shell',
      result: 'succeeded',
      metadata: { capability: PLATFORM_DEMO_CAPABILITY },
    });
    return res.json({
      ok: true,
      actorPersona: access.actorPersona,
      accessMode: access.accessMode,
      banner: PLATFORM_DEMO_BANNER,
    });
  });

  router.get('/analytics', requireDemoAccess, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      source: 'fixture',
      banner: PLATFORM_DEMO_BANNER,
      analytics: platformDemoAnalyticsFixture(),
    });
  });

  router.get('/config', requireDemoAccess, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      source: 'fixture',
      banner: PLATFORM_DEMO_BANNER,
      sections: platformDemoConfigFixtures(),
    });
  });

  router.get('/config/:sectionId', requireDemoAccess, async (req, res) => {
    const section = platformDemoConfigFixture(req.params.sectionId);
    if (!section) return res.status(404).json({ error: 'Demo config section not found', code: 'PLATFORM_DEMO_SECTION_NOT_FOUND' });
    const access = (req as Request & { platformDemoAccess: Awaited<ReturnType<typeof resolvePlatformDemoAccess>> })
      .platformDemoAccess;
    const draft = await deps.sessions.get(access.actorUserId, access.actorTenantId, section.sectionId, now());
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      source: 'fixture',
      banner: PLATFORM_DEMO_BANNER,
      section,
      draft: draft?.draft ?? null,
      draftUpdatedAt: draft?.updatedAt ?? null,
      draftExpiresAt: draft?.expiresAt ?? null,
    });
  });

  router.put('/config/:sectionId', requireDemoAccess, async (req, res) => {
    const parsed = saveBodySchema.safeParse({
      sectionId: req.params.sectionId,
      draft: req.body?.draft ?? req.body,
    });
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid demo save payload', code: 'PLATFORM_DEMO_SAVE_INVALID' });
    }
    const section = platformDemoConfigFixture(parsed.data.sectionId);
    if (!section) {
      return res.status(404).json({ error: 'Demo config section not found', code: 'PLATFORM_DEMO_SECTION_NOT_FOUND' });
    }
    // Client validation UX is assumed complete; server only stores actor+org scoped draft.
    const access = (req as Request & { platformDemoAccess: Awaited<ReturnType<typeof resolvePlatformDemoAccess>> })
      .platformDemoAccess;
    const saved = await deps.sessions.save({
      actorUserId: access.actorUserId,
      actorTenantId: access.actorTenantId,
      sectionId: parsed.data.sectionId,
      draft: parsed.data.draft,
      now: now(),
    });
    return res.json({
      ok: true,
      source: 'demo_session',
      banner: PLATFORM_DEMO_BANNER,
      sectionId: saved.sectionId,
      draft: saved.draft,
      updatedAt: saved.updatedAt,
      expiresAt: saved.expiresAt,
      affectsProduction: false,
    });
  });

  router.get('/grants', async (req, res) => {
    try {
      await assertPlatformAdminCanManageDemoGrants(req);
    } catch (error) {
      const body = platformDemoAccessErrorBody(error);
      if (body) return res.status(body.status).json(body.body);
      return res.status(403).json({ error: 'Platform admin required' });
    }
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : '';
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    const grants = await deps.capabilities.listGrants(tenantId);
    return res.json({ grants });
  });

  router.post('/grants', async (req, res) => {
    try {
      await assertPlatformAdminCanManageDemoGrants(req);
    } catch (error) {
      const body = platformDemoAccessErrorBody(error);
      if (body) return res.status(body.status).json(body.body);
      return res.status(403).json({ error: 'Platform admin required' });
    }
    const parsed = grantBodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid grant payload' });
    const membership = await deps.getMembership(parsed.data.tenantId, parsed.data.userId);
    if (!membership || membership.status !== 'active' || membership.persona !== 'org_admin') {
      return res.status(400).json({
        error: '只能向有效组织管理员授予平台演示权限',
        code: 'PLATFORM_DEMO_GRANT_TARGET_INVALID',
      });
    }
    const grant = await deps.capabilities.grant({
      tenantId: parsed.data.tenantId,
      userId: parsed.data.userId,
      grantedBy: req.user!.sub,
      now: now(),
    });
    await appendDemoAudit(deps.audit, {
      correlationId: `platform-demo-grant:${grant.userId}`,
      actorType: 'user',
      actorUserId: req.user!.sub,
      actorPersona: 'platform_admin',
      actorTenantId: req.user!.tenantId,
      action: 'platform_demo.grant',
      targetType: 'membership_capability',
      targetId: grant.userId,
      targetTenantId: grant.tenantId,
      purpose: 'grant platform demo access',
      result: 'succeeded',
      metadata: { capability: PLATFORM_DEMO_CAPABILITY },
    });
    return res.status(201).json({ grant });
  });

  router.delete('/grants', async (req, res) => {
    try {
      await assertPlatformAdminCanManageDemoGrants(req);
    } catch (error) {
      const body = platformDemoAccessErrorBody(error);
      if (body) return res.status(body.status).json(body.body);
      return res.status(403).json({ error: 'Platform admin required' });
    }
    const parsed = grantBodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid revoke payload' });
    const revoked = await deps.capabilities.revoke({
      tenantId: parsed.data.tenantId,
      userId: parsed.data.userId,
      revokedBy: req.user!.sub,
      now: now(),
    });
    if (!revoked) return res.status(404).json({ error: 'Grant not found', code: 'PLATFORM_DEMO_GRANT_NOT_FOUND' });
    await appendDemoAudit(deps.audit, {
      correlationId: `platform-demo-revoke:${revoked.userId}`,
      actorType: 'user',
      actorUserId: req.user!.sub,
      actorPersona: 'platform_admin',
      actorTenantId: req.user!.tenantId,
      action: 'platform_demo.revoke',
      targetType: 'membership_capability',
      targetId: revoked.userId,
      targetTenantId: revoked.tenantId,
      purpose: 'revoke platform demo access',
      result: 'succeeded',
      metadata: { capability: PLATFORM_DEMO_CAPABILITY },
    });
    return res.json({ grant: revoked });
  });

  return router;
}

