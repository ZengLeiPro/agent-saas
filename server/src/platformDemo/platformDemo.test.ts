import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TenantMembership } from '../data/memberships/types.js';
import { InMemoryPlatformDemoCapabilityStore } from './capabilityStore.js';
import { InMemoryPlatformDemoSessionStore } from './demoSessionStore.js';
import { platformDemoAnalyticsFixture, platformDemoConfigFixture } from './fixtures.js';
import {
  assertDemoIdentityBlockedFromProductionWrite,
  createRejectPlatformDemoProductionWrites,
} from './rejectProductionAdminWrites.js';
import { createPlatformDemoRouter } from './routes.js';
import { isPlatformDemoFeatureEnabled, PLATFORM_DEMO_CAPABILITY } from './types.js';

function membership(overrides: Partial<TenantMembership> = {}): TenantMembership {
  return {
    tenantId: 'acme',
    userId: 'org-admin-1',
    persona: 'org_admin',
    isOwner: true,
    status: 'active',
    source: 'governance',
    version: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    createdBy: 'bootstrap',
    updatedAt: '2026-09-01T00:00:00.000Z',
    updatedBy: 'bootstrap',
    ...overrides,
  };
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('platform demo mode', () => {
  let server: Server | undefined;
  let capabilities: InMemoryPlatformDemoCapabilityStore;
  let sessions: InMemoryPlatformDemoSessionStore;
  const memberships = new Map<string, TenantMembership>();

  beforeEach(() => {
    capabilities = new InMemoryPlatformDemoCapabilityStore();
    sessions = new InMemoryPlatformDemoSessionStore();
    memberships.clear();
    memberships.set('acme::org-admin-1', membership());
  });

  afterEach(() => new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve()));

  function buildApp(options?: { featureEnabled?: boolean }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const userHeader = req.header('x-test-user');
      if (userHeader === 'platform-admin') {
        req.user = { sub: 'platform-1', username: 'root', role: 'admin', tenantId: 'pantheon' };
      } else if (userHeader === 'org-admin') {
        req.user = { sub: 'org-admin-1', username: 'acme-admin', role: 'admin', tenantId: 'acme' };
      } else if (userHeader === 'org-admin-2') {
        req.user = { sub: 'org-admin-2', username: 'acme-admin-2', role: 'admin', tenantId: 'acme' };
      } else if (userHeader === 'member') {
        req.user = { sub: 'member-1', username: 'acme-user', role: 'user', tenantId: 'acme' };
      }
      next();
    });
    app.use('/api', createRejectPlatformDemoProductionWrites({ capabilities }));
    app.post('/api/admin/config-operations/demo-write', (_req, res) => {
      res.json({ ok: true, production: true });
    });
    app.use(
      '/api/platform-demo',
      createPlatformDemoRouter({
        capabilities,
        sessions,
        getMembership: async (tenantId, userId) => memberships.get(`${tenantId}::${userId}`) ?? null,
        featureEnabled: () => options?.featureEnabled ?? true,
      }),
    );
    return app;
  }

  it('gates capability: org_admin without grant cannot enter demo', async () => {
    const listening = await listen(buildApp());
    server = listening.server;
    const access = await fetch(`${listening.baseUrl}/api/platform-demo/access`, {
      headers: { 'x-test-user': 'org-admin' },
    });
    expect(access.status).toBe(200);
    await expect(access.json()).resolves.toMatchObject({
      allowed: false,
      reasonCode: 'PLATFORM_DEMO_FORBIDDEN',
    });
    const analytics = await fetch(`${listening.baseUrl}/api/platform-demo/analytics`, {
      headers: { 'x-test-user': 'org-admin' },
    });
    expect(analytics.status).toBe(403);
  });

  it('serves fixture analytics and config for granted org_admin', async () => {
    await capabilities.grant({
      tenantId: 'acme',
      userId: 'org-admin-1',
      grantedBy: 'platform-1',
    });
    const listening = await listen(buildApp());
    server = listening.server;

    const access = await fetch(`${listening.baseUrl}/api/platform-demo/access`, {
      headers: { 'x-test-user': 'org-admin' },
    });
    await expect(access.json()).resolves.toMatchObject({
      allowed: true,
      actorPersona: 'platform_demo',
      accessMode: 'platform_demo',
    });

    const analytics = await fetch(`${listening.baseUrl}/api/platform-demo/analytics`, {
      headers: { 'x-test-user': 'org-admin' },
    });
    expect(analytics.status).toBe(200);
    const analyticsBody = await analytics.json();
    expect(analyticsBody).toMatchObject({
      source: 'fixture',
      analytics: platformDemoAnalyticsFixture(),
    });

    const config = await fetch(`${listening.baseUrl}/api/platform-demo/config/models`, {
      headers: { 'x-test-user': 'org-admin' },
    });
    expect(config.status).toBe(200);
    await expect(config.json()).resolves.toMatchObject({
      source: 'fixture',
      section: platformDemoConfigFixture('models'),
      draft: null,
    });
  });

  it('saves demo_session drafts per actor+org and isolates other users', async () => {
    await capabilities.grant({
      tenantId: 'acme',
      userId: 'org-admin-1',
      grantedBy: 'platform-1',
    });
    memberships.set('acme::org-admin-2', membership({ userId: 'org-admin-2' }));
    await capabilities.grant({
      tenantId: 'acme',
      userId: 'org-admin-2',
      grantedBy: 'platform-1',
    });

    const listening = await listen(buildApp());
    server = listening.server;

    const save = await fetch(`${listening.baseUrl}/api/platform-demo/config/models`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': 'org-admin' },
      body: JSON.stringify({ draft: { defaultModel: 'demo-model/coding' } }),
    });
    expect(save.status).toBe(200);
    const saved = await save.json();
    expect(saved).toMatchObject({
      ok: true,
      source: 'demo_session',
      affectsProduction: false,
      draft: { defaultModel: 'demo-model/coding' },
    });

    const ownRead = await fetch(`${listening.baseUrl}/api/platform-demo/config/models`, {
      headers: { 'x-test-user': 'org-admin' },
    });
    await expect(ownRead.json()).resolves.toMatchObject({
      draft: { defaultModel: 'demo-model/coding' },
    });

    const otherRead = await fetch(`${listening.baseUrl}/api/platform-demo/config/models`, {
      headers: { 'x-test-user': 'org-admin-2' },
    });
    await expect(otherRead.json()).resolves.toMatchObject({ draft: null });
  });

  it('rejects demo identity production admin writes with 403', async () => {
    await capabilities.grant({
      tenantId: 'acme',
      userId: 'org-admin-1',
      grantedBy: 'platform-1',
    });
    const listening = await listen(buildApp());
    server = listening.server;

    const response = await fetch(`${listening.baseUrl}/api/admin/config-operations/demo-write`, {
      method: 'POST',
      headers: { 'x-test-user': 'org-admin', 'content-type': 'application/json' },
      body: JSON.stringify({ raw: 'should-not-write' }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'PLATFORM_DEMO_PRODUCTION_WRITE_FORBIDDEN',
    });

    await expect(assertDemoIdentityBlockedFromProductionWrite({
      method: 'PUT',
      path: '/api/admin/models',
      actor: { sub: 'org-admin-1', tenantId: 'acme', role: 'admin' },
      isPlatformAdmin: false,
      hasDemoGrant: true,
    })).resolves.toEqual({
      allowed: false,
      code: 'PLATFORM_DEMO_PRODUCTION_WRITE_FORBIDDEN',
    });
  });

  it('allows platform_admin to grant and revoke membership-scoped capability', async () => {
    const listening = await listen(buildApp());
    server = listening.server;

    const denied = await fetch(`${listening.baseUrl}/api/platform-demo/grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'org-admin' },
      body: JSON.stringify({ tenantId: 'acme', userId: 'org-admin-1' }),
    });
    expect(denied.status).toBe(403);

    const granted = await fetch(`${listening.baseUrl}/api/platform-demo/grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'platform-admin' },
      body: JSON.stringify({ tenantId: 'acme', userId: 'org-admin-1' }),
    });
    expect(granted.status).toBe(201);
    await expect(granted.json()).resolves.toMatchObject({
      grant: {
        tenantId: 'acme',
        userId: 'org-admin-1',
        capability: PLATFORM_DEMO_CAPABILITY,
      },
    });

    const revoked = await fetch(`${listening.baseUrl}/api/platform-demo/grants`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'x-test-user': 'platform-admin' },
      body: JSON.stringify({ tenantId: 'acme', userId: 'org-admin-1' }),
    });
    expect(revoked.status).toBe(200);
  });

  it('honors feature flag disable', async () => {
    await capabilities.grant({
      tenantId: 'acme',
      userId: 'org-admin-1',
      grantedBy: 'platform-1',
    });
    const listening = await listen(buildApp({ featureEnabled: false }));
    server = listening.server;
    const access = await fetch(`${listening.baseUrl}/api/platform-demo/access`, {
      headers: { 'x-test-user': 'org-admin' },
    });
    await expect(access.json()).resolves.toMatchObject({
      allowed: false,
      featureEnabled: false,
      reasonCode: 'PLATFORM_DEMO_DISABLED',
    });
    expect(isPlatformDemoFeatureEnabled({ PLATFORM_DEMO_MODE_ENABLED: 'false' })).toBe(false);
    expect(isPlatformDemoFeatureEnabled({})).toBe(true);
  });
});
