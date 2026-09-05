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

async function rig(persona = 'org_admin') {
  let scope = {
    tenantId: 'tenant-a',
    resourceType: 'model',
    mode: 'all',
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
      auth: { jwtSecret: 'model-scope-runtime-test-secret-20260905' },
      models: { groups: [{ id: 'test', models: [{ id: 'first' }, { id: 'second' }] }] },
    },
    tenantStore: { findByIdStrict: vi.fn((id) => (id === 'tenant-a' ? { id } : undefined)) },
    membershipStore: {
      getPlatformAdmin: vi.fn().mockResolvedValue(null),
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
    req.user = { sub: 'admin-a', username: 'admin-a', tenantId: 'tenant-a', role: 'admin' };
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
    fetch(`http://127.0.0.1:${address.port}/api/governance/access/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { request, runtime, listMemberships, listByKind, replaceResourceScope, enqueue };
}

const change = { expectedVersion: 1, mode: 'selected', resourceIds: ['test/second'] };
const previewPath = 'entitlement-scopes/model/preview';

describe('模型范围的真实运行时路由接线', () => {
  it('组织管理员可预览、保存并回读模型范围，影响清单隔离组织且排除未启用主体', async () => {
    const test = await rig();
    const response = await test.request(previewPath, 'POST', change);
    expect(response.status).toBe(200);
    const preview = await response.json();
    expect(preview.impact.affectedResources).toEqual([
      { type: 'membership', id: 'admin-a', version: 2 },
      { type: 'org_agent', id: 'org_agent-a', version: 5 },
      { type: 'personal_agent', id: 'personal_agent-a', version: 5 },
    ]);
    expect(test.listByKind).toHaveBeenCalledWith('personal_agent', 'tenant-a');
    expect(test.listByKind).toHaveBeenCalledWith('org_agent', 'tenant-a');
    expect(test.replaceResourceScope).not.toHaveBeenCalled();
    const saved = await test.request(
      'entitlement-scopes/model',
      'PUT',
      commitBody(change, preview),
    );
    expect(saved.status).toBe(200);
    expect(test.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', projector: 'tenant_settings' }),
    );
    const read = await test.request('entitlements');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      scopes: [
        expect.objectContaining({ mode: 'selected', resourceIds: ['test/second'], version: 2 }),
      ],
    });
    const all = { expectedVersion: 2, mode: 'all', resourceIds: [] };
    const allPreview = await test.request(previewPath, 'POST', all);
    expect(allPreview.status).toBe(200);
    const allSaved = await test.request(
      'entitlement-scopes/model',
      'PUT',
      commitBody(all, await allPreview.json()),
    );
    expect(allSaved.status).toBe(200);
    expect(await allSaved.json()).toMatchObject({ mode: 'all', resourceIds: [], version: 3 });
  });

  it('依赖查询失败仍关闭预览，不能伪造空影响结果', async () => {
    const test = await rig();
    test.listMemberships.mockRejectedValue(new Error('database unavailable'));
    const response = await test.request(previewPath, 'POST', change);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'DEPENDENCY_IMPACT_AUTHORITY_UNAVAILABLE',
    });
    expect(test.replaceResourceScope).not.toHaveBeenCalled();
  });

  it('缺少 Agent 权威目录仍拒绝预览', async () => {
    const test = await rig();
    test.runtime.agentResourceStore = undefined;
    expect((await test.request(previewPath, 'POST', change)).status).toBe(503);
  });

  it('组织管理员不能跨组织预览', async () => {
    const test = await rig();
    expect((await test.request(`${previewPath}?tenantId=tenant-b`, 'POST', change)).status).toBe(
      403,
    );
    expect(test.listMemberships).not.toHaveBeenCalled();
  });

  it('普通成员不能修改模型范围', async () => {
    const test = await rig('member');
    expect((await test.request(previewPath, 'POST', change)).status).toBe(403);
    expect(test.listMemberships).not.toHaveBeenCalled();
  });

  it('模型目录变更后拒绝旧预览提交', async () => {
    const test = await rig();
    const preview = await (await test.request(previewPath, 'POST', change)).json();
    test.runtime.config.models!.groups[0]!.models.pop();
    const response = await test.request(
      'entitlement-scopes/model',
      'PUT',
      commitBody(change, preview),
    );
    expect(response.status).toBe(409);
    expect(test.replaceResourceScope).not.toHaveBeenCalled();
  });
});
