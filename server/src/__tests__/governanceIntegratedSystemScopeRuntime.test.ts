import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGovernanceRoutes } from '../app/governanceRoutes.js';
import type { AppRuntime } from '../app/runtime.js';
import { commitBody } from './governanceAccessTestSupport.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function rig(persona = 'platform_admin') {
  const scope = {
    tenantId: 'tenant-a',
    resourceType: 'integrated_system',
    mode: 'selected',
    resourceIds: [] as string[],
    version: 1,
  };
  const listMemberships = vi.fn().mockResolvedValue([
    { tenantId: 'tenant-a', userId: 'admin-a', status: 'active', version: 2 },
    { tenantId: 'tenant-a', userId: 'disabled-a', status: 'disabled', version: 3 },
    { tenantId: 'tenant-b', userId: 'member-b', status: 'active', version: 4 },
  ]);
  const replaceResourceScope = vi.fn();
  const enqueue = vi.fn().mockResolvedValue({ projectionId: 'projection-1' });
  const runtime = {
    config: {
      auth: { jwtSecret: 'system-scope-runtime-test-secret-20260908' },
      models: { groups: [{ id: 'test', models: [{ id: 'first' }, { id: 'second' }] }] },
    },
    tenantStore: { findByIdStrict: vi.fn((id) => (id === 'tenant-a' ? { id } : undefined)) },
    membershipStore: {
      getPlatformAdmin: vi
        .fn()
        .mockResolvedValue(
          persona === 'platform_admin' ? { userId: 'admin-a', status: 'active', version: 1 } : null,
        ),
      getMembership: vi.fn().mockResolvedValue({
        tenantId: 'tenant-a',
        userId: 'admin-a',
        status: 'active',
        persona,
        version: 2,
      }),
      listMemberships,
    },
    agentResourceStore: { listByKind: vi.fn().mockResolvedValue([]) },
    kyAppSystemStore: {
      listDefinitions: vi
        .fn()
        .mockResolvedValue([{ systemId: 'demo-system', status: 'published', version: 1 }]),
      getDefinition: vi.fn(async (id: string) =>
        id === 'demo-system' ? { systemId: id, status: 'published', version: 1 } : null,
      ),
      listInstallationsForTenant: vi.fn().mockResolvedValue([]),
    },
    entitlementStore: {
      getEntitlementSet: vi
        .fn()
        .mockResolvedValue({ tenantId: 'tenant-a', status: 'active', version: 1 }),
      listResourceScopes: vi.fn().mockResolvedValue([scope]),
      getPolicies: vi.fn().mockResolvedValue([]),
      replaceResourceScope,
    },
    assignmentStore: {},
    governanceAuditStore: { append: vi.fn().mockResolvedValue({ auditId: 'audit-1' }) },
    governanceProjectionOutboxStore: { enqueue },
  } as unknown as AppRuntime;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      sub: 'admin-a',
      username: 'admin-a',
      tenantId: persona === 'platform_admin' ? 'pantheon' : 'tenant-a',
      role: 'admin',
    };
    next();
  });
  registerGovernanceRoutes(app, runtime, {});
  const server: Server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务地址不可用');
  const request = (path: string, method = 'GET', body?: unknown) =>
    fetch(
      `http://127.0.0.1:${address.port}/api/governance/access/${path}${persona === 'platform_admin' && !path.includes('?') ? '?tenantId=tenant-a' : ''}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
  return { request, runtime, listMemberships, replaceResourceScope, enqueue };
}

const change = { expectedVersion: 1, mode: 'selected', resourceIds: ['demo-system'] };
const previewPath = 'entitlement-scopes/integrated_system/preview';

describe('业务系统范围平台级全开的运行时守卫', () => {
  it('integrated_system 范围不可预览、不可提交，权威读取也不返回', async () => {
    const test = await rig();
    expect((await test.request(previewPath, 'POST', change)).status).toBe(400);
    expect(
      (
        await test.request(
          'entitlement-scopes/integrated_system',
          'PUT',
          commitBody(change, { previewId: 'gpv1.' + '0'.repeat(64), baselineDigest: '0'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() }),
        )
      ).status,
    ).toBe(400);
    expect(test.replaceResourceScope).not.toHaveBeenCalled();
    expect(test.enqueue).not.toHaveBeenCalled();
    const read = await test.request('entitlements');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ scopes: [] });
  });

  it('仅隐藏历史业务系统范围，不隐藏其他有效治理范围', async () => {
    const test = await rig();
    vi.mocked(test.runtime.entitlementStore!.listResourceScopes).mockResolvedValue([
      { tenantId: 'tenant-a', resourceType: 'integrated_system', mode: 'all', resourceIds: [], version: 7 },
      { tenantId: 'tenant-a', resourceType: 'skill', mode: 'selected', resourceIds: ['skill-a'], version: 3 },
    ] as never);
    const read = await test.request('entitlements');
    expect(read.status).toBe(200);
    const { scopes } = await read.json();
    expect(scopes).toEqual([
      expect.objectContaining({ resourceType: 'skill', resourceIds: ['skill-a'], version: 3,
        allowedActions: [expect.objectContaining({ id: 'edit_scope' })] }),
    ]);
  });

  it('组织管理员不能跨组织访问，权限门槛保持在前', async () => {
    const test = await rig('org_admin');
    expect((await test.request(`${previewPath}?tenantId=tenant-b`, 'POST', change)).status).toBe(
      403,
    );
    expect(test.listMemberships).not.toHaveBeenCalled();
  });

  it('普通成员不能访问业务系统范围端点', async () => {
    const test = await rig('member');
    expect((await test.request(previewPath, 'POST', change)).status).toBe(403);
    expect(test.listMemberships).not.toHaveBeenCalled();
  });
});
