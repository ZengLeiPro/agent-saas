import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { resolveRuntimeTenantLifecycleImpact } from '../app/governanceRoutes.js';
import { TenantStore } from '../data/tenants/store.js';
import { registerGovernanceTenantLifecycleRoutes } from '../routes/governanceTenantLifecycleRoutes.js';

const SECRET = 'tenant-lifecycle-test-secret-2026-08-14';
const NOW = '2026-08-14T14:00:00.000Z';

type Method = 'get' | 'post';
type RouteHandler = (req: never, res: never) => unknown;

function commitBody(change: Record<string, unknown>, preview: Record<string, unknown>) {
  return {
    ...change,
    previewId: preview.previewId,
    baselineDigest: preview.baselineDigest,
    expiresAt: preview.expiresAt,
  };
}

function findHandler(router: express.Router, path: string, method: Method): RouteHandler {
  const layer = (router as unknown as { stack: Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RouteHandler }> };
  }> }).stack.find(item => item.route?.path === path && item.route.methods[method]);
  if (!layer?.route) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0]!.handle;
}

function rig(input: {
  dependencyImpact: (
    tenantId: string,
    action: 'suspend' | 'resume',
  ) => Promise<{ affectedResources: Array<{ type: string; id: string; version: number }>; blockers: string[] }>;
  setTenantDisabled?: (
    tenantId: string,
    disabled: boolean,
    actorUserId: string,
    expectedUpdatedAt: string,
  ) => Promise<{ id: string; name?: string; disabled?: boolean; updatedAt: string }>;
  persona?: 'platform_admin' | 'org_admin' | 'member';
  tenantDisabled?: boolean;
}) {
  const router = express.Router();
  const setTenantDisabled = vi.fn(input.setTenantDisabled ?? (async () => ({
    id: 'tenant-a', name: '测试组织', disabled: true, updatedAt: '2026-08-14T14:01:00.000Z',
  })));
  registerGovernanceTenantLifecycleRoutes({
    router,
    secret: SECRET,
    previewTtlMs: 5 * 60_000,
    now: () => new Date(NOW),
    personaFor: () => input.persona ?? 'platform_admin',
    getTenant: tenantId => tenantId === 'tenant-a'
      ? { id: tenantId, name: '测试组织', ...(input.tenantDisabled ? { disabled: true } : {}), updatedAt: NOW }
      : undefined,
    setTenantDisabled,
    dependencyImpact: input.dependencyImpact,
  });
  const request = async (path: string, method: Method, body: Record<string, unknown> = {}) => {
    const req = {
      query: { tenantId: 'tenant-a' },
      body,
      user: { sub: 'platform-1', username: 'platform', tenantId: 'pantheon', role: 'admin' },
    };
    const response = {
      statusCode: 200,
      body: undefined as unknown,
      locals: { governanceChangeId: 'change-1' },
      status(code: number) { this.statusCode = code; return this; },
      json(value: unknown) { this.body = value; return this; },
    };
    await findHandler(router, path, method)(req as never, response as never);
    return response;
  };
  return { request, setTenantDisabled };
}

function storeRig(store: TenantStore) {
  const router = express.Router();
  registerGovernanceTenantLifecycleRoutes({
    router,
    secret: SECRET,
    previewTtlMs: 5 * 60_000,
    now: () => new Date(NOW),
    personaFor: () => 'platform_admin',
    getTenant: tenantId => store.findById(tenantId),
    setTenantDisabled: (tenantId, disabled, actorUserId, expectedUpdatedAt) =>
      store.setDisabled(tenantId, disabled, actorUserId, expectedUpdatedAt),
    dependencyImpact: async () => ({ affectedResources: [], blockers: [] }),
  });
  return async (
    tenantId: string,
    path: string,
    method: Method,
    body: Record<string, unknown> = {},
  ) => {
    const req = {
      query: { tenantId },
      body,
      user: { sub: 'platform-1', username: 'platform', tenantId: 'pantheon', role: 'admin' },
    };
    const response = {
      statusCode: 200,
      body: undefined as unknown,
      locals: { governanceChangeId: 'change-1' },
      status(code: number) { this.statusCode = code; return this; },
      json(value: unknown) { this.body = value; return this; },
    };
    await findHandler(router, path, method)(req as never, response as never);
    return response;
  };
}

describe('tenant lifecycle routes', () => {
  it('生产影响解析器返回活动成员，并按动作判断最后启用组织阻断', async () => {
    const listMemberships = vi.fn().mockResolvedValue([
      { userId: 'user-b', status: 'active', version: 3 },
      { userId: 'user-a', status: 'active', version: 2 },
      { userId: 'user-disabled', status: 'disabled', version: 4 },
    ]);
    const runtime = {
      tenantStore: { findById: vi.fn().mockReturnValue({ id: 'tenant-a' }), activeCount: vi.fn().mockReturnValue(1) },
      membershipStore: { listMemberships },
    } as never;

    await expect(resolveRuntimeTenantLifecycleImpact(runtime, 'tenant-a', 'suspend')).resolves.toEqual({
      affectedResources: [
        { type: 'membership', id: 'user-a', version: 2 },
        { type: 'membership', id: 'user-b', version: 3 },
      ],
      blockers: ['不能暂停最后一个启用组织'],
    });
    await expect(resolveRuntimeTenantLifecycleImpact(runtime, 'tenant-a', 'resume')).resolves.toMatchObject({ blockers: [] });
  });

  it('普通组织管理员不能读取或直接调用生命周期接口', async () => {
    const dependencyImpact = vi.fn().mockResolvedValue({ affectedResources: [], blockers: [] });
    const test = rig({ dependencyImpact, persona: 'org_admin' });

    const response = await test.request('/tenant-lifecycle', 'get');
    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ error: 'Platform admin required' });
    expect(dependencyImpact).not.toHaveBeenCalled();
    expect(test.setTenantDisabled).not.toHaveBeenCalled();
  });

  it('平台管理员可按预览基线暂停组织，且响应包含明确目标组织', async () => {
    const dependencyImpact = vi.fn().mockResolvedValue({
      affectedResources: [{ type: 'membership', id: 'user-2', version: 1 }], blockers: [],
    });
    const test = rig({ dependencyImpact });
    const lifecycle = await test.request('/tenant-lifecycle', 'get');
    expect(lifecycle.body).toMatchObject({
      tenantId: 'tenant-a', tenantName: '测试组织', status: 'active', allowedActions: [{ action: 'suspend' }],
    });

    const change = { action: 'suspend', reason: 'customer security incident' };
    const preview = await test.request('/tenant-lifecycle/preview', 'post', change);
    const committed = await test.request(
      '/tenant-lifecycle', 'post', commitBody(change, preview.body as Record<string, unknown>),
    );
    expect(committed.statusCode).toBe(200);
    expect(committed.body).toMatchObject({ tenantId: 'tenant-a', status: 'suspended' });
    expect(test.setTenantDisabled).toHaveBeenCalledWith('tenant-a', true, 'platform-1', NOW);
  });

  it('提交阶段重新校验 blockers，不能绕过前端直接暂停', async () => {
    const dependencyImpact = vi.fn().mockResolvedValue({
      affectedResources: [{ type: 'membership', id: 'user-2', version: 1 }],
      blockers: ['不能暂停最后一个启用组织'],
    });
    const test = rig({ dependencyImpact });
    const change = { action: 'suspend', reason: 'customer security incident' };
    const preview = await test.request('/tenant-lifecycle/preview', 'post', change);
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toMatchObject({ impact: { blockers: ['不能暂停最后一个启用组织'] } });

    const committed = await test.request(
      '/tenant-lifecycle', 'post', commitBody(change, preview.body as Record<string, unknown>),
    );
    expect(committed.statusCode).toBe(409);
    expect(committed.body).toMatchObject({
      code: 'TENANT_LIFECYCLE_BLOCKED', blockers: ['不能暂停最后一个启用组织'],
    });
    expect(test.setTenantDisabled).not.toHaveBeenCalled();
    expect(dependencyImpact).toHaveBeenNthCalledWith(1, 'tenant-a', 'suspend');
    expect(dependencyImpact).toHaveBeenNthCalledWith(2, 'tenant-a', 'suspend');
  });

  it('确认后影响资源版本变化会使预览失效', async () => {
    const dependencyImpact = vi.fn()
      .mockResolvedValueOnce({ affectedResources: [{ type: 'membership', id: 'user-2', version: 1 }], blockers: [] })
      .mockResolvedValueOnce({ affectedResources: [{ type: 'membership', id: 'user-2', version: 2 }], blockers: [] });
    const test = rig({ dependencyImpact });
    const change = { action: 'suspend', reason: 'customer security incident' };
    const preview = await test.request('/tenant-lifecycle/preview', 'post', change);
    const committed = await test.request(
      '/tenant-lifecycle', 'post', commitBody(change, preview.body as Record<string, unknown>),
    );

    expect(committed.statusCode).toBe(409);
    expect(committed.body).toMatchObject({ code: 'TENANT_LIFECYCLE_BASELINE_CONFLICT' });
    expect(test.setTenantDisabled).not.toHaveBeenCalled();
  });

  it('两个路由实例共享 tenants.json 时并发禁用不同组织不会互相覆盖', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tenant-lifecycle-routes-'));
    const storePath = join(root, 'tenants.json');
    try {
      const seed = new TenantStore(storePath);
      await seed.create({ id: 'tenant-a', name: '组织 A', createdBy: 'system' });
      await seed.create({ id: 'tenant-b', name: '组织 B', createdBy: 'system' });
      await seed.create({ id: 'tenant-c', name: '组织 C', createdBy: 'system' });
      const requestA = storeRig(new TenantStore(storePath));
      const requestB = storeRig(new TenantStore(storePath));
      const change = { action: 'suspend', reason: 'multi instance concurrency test' };
      const [previewA, previewB] = await Promise.all([
        requestA('tenant-a', '/tenant-lifecycle/preview', 'post', change),
        requestB('tenant-b', '/tenant-lifecycle/preview', 'post', change),
      ]);

      const committed = await Promise.all([
        requestA('tenant-a', '/tenant-lifecycle', 'post', commitBody(change, previewA.body as Record<string, unknown>)),
        requestB('tenant-b', '/tenant-lifecycle', 'post', commitBody(change, previewB.body as Record<string, unknown>)),
      ]);

      expect(committed.map(response => response.statusCode)).toEqual([200, 200]);
      const persisted = new TenantStore(storePath);
      expect(persisted.findById('tenant-a')?.disabled).toBe(true);
      expect(persisted.findById('tenant-b')?.disabled).toBe(true);
      expect(persisted.findById('tenant-c')?.disabled).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('两个路由实例共享 tenants.json 时同组织重复提交仅一个成功', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tenant-lifecycle-routes-'));
    const storePath = join(root, 'tenants.json');
    try {
      const seed = new TenantStore(storePath);
      await seed.create({ id: 'tenant-a', name: '组织 A', createdBy: 'system' });
      await seed.create({ id: 'tenant-b', name: '组织 B', createdBy: 'system' });
      const requestA = storeRig(new TenantStore(storePath));
      const requestB = storeRig(new TenantStore(storePath));
      const change = { action: 'suspend', reason: 'duplicate multi instance test' };
      const [previewA, previewB] = await Promise.all([
        requestA('tenant-a', '/tenant-lifecycle/preview', 'post', change),
        requestB('tenant-a', '/tenant-lifecycle/preview', 'post', change),
      ]);

      const committed = await Promise.all([
        requestA('tenant-a', '/tenant-lifecycle', 'post', commitBody(change, previewA.body as Record<string, unknown>)),
        requestB('tenant-a', '/tenant-lifecycle', 'post', commitBody(change, previewB.body as Record<string, unknown>)),
      ]);

      expect(committed.filter(response => response.statusCode === 200)).toHaveLength(1);
      const conflict = committed.find(response => response.statusCode === 409);
      expect(conflict?.body).toMatchObject({ code: 'TENANT_LIFECYCLE_BASELINE_CONFLICT' });
      expect(new TenantStore(storePath).findById('tenant-a')?.disabled).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('同一组织已有状态提交时拒绝并发请求', async () => {
    let releaseMutation!: () => void;
    const setTenantDisabled = vi.fn(() => new Promise<{ id: string; disabled: true; updatedAt: string }>(resolve => {
      releaseMutation = () => resolve({ id: 'tenant-a', disabled: true, updatedAt: '2026-08-14T14:01:00.000Z' });
    }));
    const dependencyImpact = vi.fn().mockResolvedValue({ affectedResources: [], blockers: [] });
    const test = rig({ dependencyImpact, setTenantDisabled });
    const change = { action: 'suspend', reason: 'customer security incident' };
    const preview = await test.request('/tenant-lifecycle/preview', 'post', change);
    const commit = commitBody(change, preview.body as Record<string, unknown>);

    const first = test.request('/tenant-lifecycle', 'post', commit);
    await vi.waitFor(() => expect(setTenantDisabled).toHaveBeenCalledTimes(1));
    const concurrent = await test.request('/tenant-lifecycle', 'post', commit);

    expect(concurrent.statusCode).toBe(409);
    expect(concurrent.body).toMatchObject({ code: 'TENANT_LIFECYCLE_TRANSITION_IN_PROGRESS' });
    expect(setTenantDisabled).toHaveBeenCalledTimes(1);
    releaseMutation();
    await expect(first).resolves.toMatchObject({ statusCode: 200 });
  });
});
