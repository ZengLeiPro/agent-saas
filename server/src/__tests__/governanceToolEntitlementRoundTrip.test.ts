import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppRuntime } from '../app/runtime.js';
import {
  createEntitlementResourceCatalogResolver,
  createEntitlementResourceResolver,
} from '../app/runtimeAssignmentResourceResolver.js';
import type { EntitlementResourceScope } from '../data/entitlements/types.js';
import { createGovernanceAccessRouter } from '../routes/governanceAccess.js';
import { commitBody } from './governanceAccessTestSupport.js';

const NOW = '2026-09-04T00:00:00.000Z';
const PREVIEW_SECRET = 'governance-tool-round-trip-preview-secret';
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function rig() {
  let scope: EntitlementResourceScope = {
    tenantId: 'tenant-a',
    resourceType: 'tool',
    mode: 'selected',
    resourceIds: ['personal_agent'],
    source: 'governance',
    version: 1,
    createdAt: NOW,
    createdBy: 'platform-1',
    updatedAt: NOW,
    updatedBy: 'platform-1',
  };
  const runtime = { config: {} } as AppRuntime;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: 'platform-1', username: 'platform', tenantId: 'pantheon', role: 'admin' };
    next();
  });
  app.use('/api/governance/access', createGovernanceAccessRouter({
    memberships: {
      getPlatformAdmin: vi.fn().mockResolvedValue({ userId: 'platform-1', status: 'active', version: 1 }),
      getMembership: vi.fn().mockResolvedValue(null),
      listMemberships: vi.fn().mockResolvedValue([]),
    } as never,
    entitlements: {
      getEntitlementSet: vi.fn().mockResolvedValue({
        tenantId: 'tenant-a', source: 'governance', status: 'active', limits: {}, version: 1,
        createdAt: NOW, createdBy: 'platform-1', updatedAt: NOW, updatedBy: 'platform-1',
      }),
      listResourceScopes: vi.fn().mockImplementation(async () => [scope]),
      getPolicies: vi.fn().mockResolvedValue([]),
      replaceResourceScope: vi.fn().mockImplementation(async (
        _tenantId: string,
        resourceType: 'tool',
        patch: { mode: 'all' | 'selected'; resourceIds: string[] },
      ) => {
        scope = {
          ...scope,
          resourceType,
          mode: patch.mode,
          resourceIds: patch.mode === 'all' ? [] : patch.resourceIds,
          version: scope.version + 1,
          updatedAt: '2026-09-04T00:01:00.000Z',
        };
        return scope;
      }),
    } as never,
    assignments: {
      getAssignmentSet: vi.fn().mockResolvedValue(null),
      listUserPreferences: vi.fn().mockResolvedValue([]),
      listEffectiveResourceIds: vi.fn().mockResolvedValue([]),
    } as never,
    resolveAssignmentResource: async () => 'valid',
    resolveEntitlementResource: createEntitlementResourceResolver(runtime),
    listEntitlementResources: createEntitlementResourceCatalogResolver(runtime),
    resolveDependencyImpact: async () => ({
      affectedResources: [], blockers: [], affectedAgents: [], affectedAutomations: [], brokenReferences: [],
    }),
    audit: { append: vi.fn().mockResolvedValue({ auditId: 'audit-1' }) } as never,
    membershipPreviewSecret: PREVIEW_SECRET,
  }));
  const server: Server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  servers.push(server);
  const address = server.address();
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  return (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);
}

describe('tool Entitlement 范围往返', () => {
  it('selected 切 all 后仍可从权威目录恢复 personal_agent', async () => {
    const request = await rig();
    const commitScope = async (change: {
      expectedVersion: number;
      mode: 'all' | 'selected';
      resourceIds: string[];
    }) => {
      const path = '/api/governance/access/entitlement-scopes/tool';
      const previewResponse = await request(`${path}/preview?tenantId=tenant-a`, json('POST', change));
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as Record<string, unknown>;
      const commit = await request(
        `${path}?tenantId=tenant-a`,
        json('PUT', commitBody(change, preview)),
      );
      expect(commit.status).toBe(200);
      return commit.json() as Promise<{ mode: string; resourceIds: string[]; version: number }>;
    };

    await expect(commitScope({ expectedVersion: 1, mode: 'all', resourceIds: [] }))
      .resolves.toMatchObject({ mode: 'all', resourceIds: [], version: 2 });
    await expect(commitScope({ expectedVersion: 2, mode: 'selected', resourceIds: ['personal_agent'] }))
      .resolves.toMatchObject({ mode: 'selected', resourceIds: ['personal_agent'], version: 3 });
  });
});
