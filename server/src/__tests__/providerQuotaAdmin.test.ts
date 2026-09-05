import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import {
  createProviderQuotaAdminRouter,
  type CreateProviderQuotaAdminRouterOptions,
} from '../routes/providerQuotaAdmin.js';

const servers: Server[] = [];

function listen(options: CreateProviderQuotaAdminRouterOptions, role = 'admin'): string {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { sub: 'u', username: 'u', role, tenantId: DEFAULT_TENANT_ID };
    next();
  });
  app.use('/api/admin/provider-quota', createProviderQuotaAdminRouter(options));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bind failed');
  return `http://127.0.0.1:${address.port}/api/admin/provider-quota`;
}

function fakeService() {
  const overview = {
    items: [],
    collector: { enabled: true, intervalMs: 300_000, lastRunAt: null, lastError: null },
    generatedAt: 'now',
  };
  return {
    overview: vi.fn(async () => overview),
    history: vi.fn(async (hours: number) => ({ hours, points: [], generatedAt: 'now' })),
    refresh: vi.fn(async () => []),
    test: vi.fn(async () => ({ windows: [], limitReached: false })),
  };
}

describe('provider quota admin router', () => {
  afterEach(() => {
    while (servers.length > 0) servers.pop()?.close();
  });

  it('未装配服务时明确 503，而不是返回空看板', async () => {
    const base = listen({});
    const response = await fetch(base);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('未启用') });
  });

  it('非平台管理员被拒绝', async () => {
    const base = listen({ service: fakeService() }, 'user');
    expect((await fetch(base)).status).toBeGreaterThanOrEqual(401);
  });

  it('overview / history / refresh 透传服务结果，hours 非法时回落 24', async () => {
    const service = fakeService();
    const base = listen({ service });
    expect(await (await fetch(base)).json()).toMatchObject({ collector: { intervalMs: 300_000 } });
    expect(await (await fetch(`${base}/history?hours=72`)).json()).toMatchObject({ hours: 72 });
    expect(await (await fetch(`${base}/history?hours=abc`)).json()).toMatchObject({ hours: 24 });
    const refreshed = await fetch(`${base}/refresh`, { method: 'POST' });
    expect(refreshed.status).toBe(200);
    expect(service.refresh).toHaveBeenCalledTimes(1);
    expect(service.overview).toHaveBeenCalledTimes(2);
  });

  it('test：校验请求体，服务端错误转成 400 文案', async () => {
    const service = fakeService();
    service.test.mockRejectedValueOnce(new Error('GetAFPUsage 失败：InvalidAuthorization'));
    const base = listen({ service });
    const invalid = await fetch(`${base}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'volcengine_ark_plan', accessKeyId: '' }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: expect.stringContaining('Access Key ID') });
    const failed = await fetch(`${base}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'volcengine_ark_plan',
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        groupId: 'ark',
      }),
    });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ error: 'GetAFPUsage 失败：InvalidAuthorization' });
    expect(service.test).toHaveBeenLastCalledWith({
      provider: 'volcengine_ark_plan',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
      groupId: 'ark',
    });
  });
});
