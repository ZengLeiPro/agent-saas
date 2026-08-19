import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { Router } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGovernanceEntitlementRoutes } from '../routes/governanceEntitlementRoutes.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function rig(input: {
  getEntitlementSet?: ReturnType<typeof vi.fn>;
  listResourceScopes?: ReturnType<typeof vi.fn>;
  getPolicies?: ReturnType<typeof vi.fn>;
}) {
  const router = Router();
  const getEntitlementSet = input.getEntitlementSet ?? vi.fn().mockResolvedValue(null);
  const listResourceScopes = input.listResourceScopes ?? vi.fn().mockResolvedValue([]);
  const getPolicies = input.getPolicies ?? vi.fn().mockResolvedValue([]);
  registerGovernanceEntitlementRoutes({
    router,
    entitlements: { getEntitlementSet, listResourceScopes, getPolicies } as never,
    secret: 'governance-entitlement-resilience-test-secret',
    previewTtlMs: 300_000,
    now: () => new Date('2026-08-19T00:00:00.000Z'),
    personaFor: () => 'platform_admin',
    tenantFor: (_req, requested) => requested ?? null,
  });
  const app = express();
  app.use('/api/governance/access', router);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    getEntitlementSet,
    request: (tenantId: string) => fetch(`http://127.0.0.1:${port}/api/governance/access/entitlements?tenantId=${tenantId}`),
  };
}

describe('governance entitlement GET resilience', () => {
  it('平台租户返回明确冲突，不触发 customer entitlement store', async () => {
    const test = await rig({});
    const response = await test.request('pantheon');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'PLATFORM_TENANT_GOVERNANCE_FORBIDDEN' });
    expect(test.getEntitlementSet).not.toHaveBeenCalled();
  });

  it('权益依赖失败时返回 503，不让 async rejection 逃逸到进程级 handler', async () => {
    const test = await rig({
      getEntitlementSet: vi.fn().mockRejectedValue(new Error('database unavailable')),
    });
    const response = await test.request('tenant-a');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'ENTITLEMENT_AUTHORITY_UNAVAILABLE' });
  });
});
