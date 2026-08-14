import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import { resolveRuntimeTenantLifecycleImpact } from '../app/governanceRoutes.js';
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
    expect(test.setTenantDisabled).toHaveBeenCalledWith('tenant-a', true, 'platform-1');
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
