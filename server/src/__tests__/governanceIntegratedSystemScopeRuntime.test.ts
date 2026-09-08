import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGovernanceRoutes } from '../app/governanceRoutes.js';
import type { AppRuntime } from '../app/runtime.js';
import { installableScope } from '../kyapp/installations/managementPolicy.js';
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
  let scope = {
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
  const listByKind = vi.fn().mockImplementation(async (kind: string) => [
    { tenantId: 'tenant-a', agentId: `${kind}-a`, kind, status: 'enabled', revision: 5 },
    { tenantId: 'tenant-a', agentId: `${kind}-draft`, kind, status: 'draft', revision: 1 },
    { tenantId: 'tenant-b', agentId: `${kind}-b`, kind, status: 'enabled', revision: 2 },
  ]);
  const replaceResourceScope = vi
    .fn()
    .mockImplementation(async (_tenantId, _resourceType, patch) => {
      scope = {
        ...scope,
        mode: patch.mode,
        resourceIds: patch.resourceIds,
        version: scope.version + 1,
      };
      return scope;
    });
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
    agentResourceStore: { listByKind },
    kyAppSystemStore: {
      listDefinitions: vi
        .fn()
        .mockResolvedValue([{ systemId: 'demo-system', status: 'published', version: 1 }]),
      getDefinition: vi.fn(async (id: string) =>
        id === 'demo-system' ? { systemId: id, status: 'published', version: 1 } : null,
      ),
      listInstallationsForTenant: vi.fn().mockResolvedValue([
        { tenantId: 'tenant-a', installationId: 'install-a', status: 'enabled', stateVersion: 2 },
        { tenantId: 'tenant-a', installationId: 'pending-a', status: 'pending', stateVersion: 3 },
        { tenantId: 'tenant-a', installationId: 'deleted-a', status: 'deleted', stateVersion: 4 },
        { tenantId: 'tenant-b', installationId: 'install-b', status: 'enabled', stateVersion: 5 },
      ]),
    },
    entitlementStore: {
      getEntitlementSet: vi
        .fn()
        .mockResolvedValue({ tenantId: 'tenant-a', status: 'active', version: 1 }),
      listResourceScopes: vi.fn().mockImplementation(async () => [scope]),
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
  return { request, runtime, listMemberships, listByKind, replaceResourceScope, enqueue };
}

const change = { expectedVersion: 1, mode: 'selected', resourceIds: ['demo-system'] };
const previewPath = 'entitlement-scopes/integrated_system/preview';

describe('业务系统范围的真实运行时路由接线', () => {
  it('平台管理员可预览、保存并回读业务系统范围，影响清单隔离组织且排除已删除实例', async () => {
    const test = await rig();
    expect((await installableScope(test.runtime.entitlementStore, 'tenant-a'))('demo-system')).toBe(
      false,
    );
    const response = await test.request(previewPath, 'POST', change);
    expect(response.status).toBe(200);
    const preview = await response.json();
    expect(preview.impact.affectedResources).toEqual([
      { type: 'app_installation', id: 'install-a', version: 2 },
      { type: 'app_installation', id: 'pending-a', version: 3 },
    ]);
    expect(test.runtime.kyAppSystemStore!.listInstallationsForTenant).toHaveBeenCalledWith(
      'tenant-a',
    );
    expect(test.replaceResourceScope).not.toHaveBeenCalled();
    const saved = await test.request(
      'entitlement-scopes/integrated_system',
      'PUT',
      commitBody(change, preview),
    );
    expect(saved.status).toBe(200);
    expect((await installableScope(test.runtime.entitlementStore, 'tenant-a'))('demo-system')).toBe(
      true,
    );
    expect(test.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', projector: 'tenant_settings' }),
    );
    const read = await test.request('entitlements');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      scopes: [
        expect.objectContaining({ mode: 'selected', resourceIds: ['demo-system'], version: 2 }),
      ],
    });
    const all = { expectedVersion: 2, mode: 'all', resourceIds: [] };
    const allPreview = await test.request(previewPath, 'POST', all);
    expect(allPreview.status).toBe(200);
    const allSaved = await test.request(
      'entitlement-scopes/integrated_system',
      'PUT',
      commitBody(all, await allPreview.json()),
    );
    expect(allSaved.status).toBe(200);
    expect(await allSaved.json()).toMatchObject({ mode: 'all', resourceIds: [], version: 3 });
  });

  it('依赖查询失败仍关闭预览，不能伪造空影响结果', async () => {
    const test = await rig();
    vi.mocked(test.runtime.kyAppSystemStore!.listInstallationsForTenant!).mockRejectedValue(
      new Error('database unavailable'),
    );
    const response = await test.request(previewPath, 'POST', change);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE',
    });
    expect(test.replaceResourceScope).not.toHaveBeenCalled();
  });

  it('缺少安装权威目录仍拒绝预览', async () => {
    const test = await rig();
    test.runtime.kyAppSystemStore = undefined;
    expect((await test.request(previewPath, 'POST', change)).status).toBe(503);
  });

  it('组织管理员不能跨组织预览', async () => {
    const test = await rig('org_admin');
    expect((await test.request(`${previewPath}?tenantId=tenant-b`, 'POST', change)).status).toBe(
      403,
    );
    expect(test.listMemberships).not.toHaveBeenCalled();
  });

  it('普通成员不能修改业务系统范围', async () => {
    const test = await rig('member');
    expect((await test.request(previewPath, 'POST', change)).status).toBe(403);
    expect(test.listMemberships).not.toHaveBeenCalled();
  });

  it('业务系统目录变更后拒绝旧预览提交', async () => {
    const test = await rig();
    const preview = await (await test.request(previewPath, 'POST', change)).json();
    vi.mocked(test.runtime.kyAppSystemStore!.listDefinitions!).mockResolvedValue([]);
    const response = await test.request(
      'entitlement-scopes/integrated_system',
      'PUT',
      commitBody(change, preview),
    );
    expect(response.status).toBe(409);
    expect(test.replaceResourceScope).not.toHaveBeenCalled();
  });

  it('没有安装的组织可以首次授权，撤回范围后不再允许安装', async () => {
    const test = await rig('org_admin');
    vi.mocked(test.runtime.kyAppSystemStore!.listInstallationsForTenant!).mockResolvedValue([]);
    const preview = await (await test.request(previewPath, 'POST', change)).json();
    expect(preview.impact.affectedResources).toEqual([]);
    expect(
      (
        await test.request(
          'entitlement-scopes/integrated_system',
          'PUT',
          commitBody(change, preview),
        )
      ).status,
    ).toBe(200);
    const revoke = { ...change, expectedVersion: 2, resourceIds: [] };
    const revokePreview = await (await test.request(previewPath, 'POST', revoke)).json();
    expect(
      (
        await test.request(
          'entitlement-scopes/integrated_system',
          'PUT',
          commitBody(revoke, revokePreview),
        )
      ).status,
    ).toBe(200);
    expect((await installableScope(test.runtime.entitlementStore, 'tenant-a'))('demo-system')).toBe(
      false,
    );
  });
});
