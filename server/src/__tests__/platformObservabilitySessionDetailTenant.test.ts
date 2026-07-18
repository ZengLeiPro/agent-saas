/**
 * 平台可观测性 GET /sessions/:id 跨租户隔离防回归测试（routes/platformObservability.ts:301-321）
 *
 * 核实结论（assets/20260718/核实-platformObs跨租户.md）：隔离逻辑正确但零覆盖。
 * 隔离靠内联三元表达式 `isPlatformAdmin(req.user) ? undefined : req.user.tenantId`，
 * 无独立 access 分支包裹，一旦被重构极易漏判 platform，无回归网兜底。
 *
 * 本文件把「org-admin 恒带自租户、平台 admin 恒为 undefined」钉死为契约：
 * 直接 mock sessionProjectionStore.get，断言其收到的 tenantId 参数。
 */
import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlatformObservabilityRouter } from '../routes/platformObservability.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import type { JwtPayload } from '../auth/types.js';
import type { RuntimeSessionProjectionRecord } from '../runtime/sessionProjectionStore.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

// 平台 admin：pantheon 租户，by-design 跨租户
const PLATFORM_ADMIN: JwtPayload = { sub: 'root', username: 'root', role: 'admin', tenantId: DEFAULT_TENANT_ID };
// 组织 admin：wain 租户，仅可见本租户
const WAIN_ADMIN: JwtPayload = { sub: 'u-wain-admin', username: 'wain_admin', role: 'admin', tenantId: 'wain' };

const servers: Server[] = [];

async function withApp<T>(
  user: JwtPayload,
  options: Partial<Parameters<typeof createPlatformObservabilityRouter>[0]>,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/admin', createPlatformObservabilityRouter({
    config: { tenantRemoteHands: { hands: [] } } as any,
    ...options,
  }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
  return fn(`http://127.0.0.1:${addr.port}`);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('platform observability GET /sessions/:id tenant isolation', () => {
  it('org-admin 本租户命中：store.get 收到自租户 tenantId，返回 200 + session/runs/billing/sandboxes', async () => {
    // store 按传入 tenantId 过滤：只有 tenantId==='wain' 才命中 wain 的 session
    const get = vi.fn(async (_id: string, opts: { tenantId?: string }) =>
      opts.tenantId === 'wain' ? sessionRecord({ tenantId: 'wain' }) : null);
    const sessionProjectionStore = { get } as any;

    await withApp(WAIN_ADMIN, { sessionProjectionStore }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/sessions/${SESSION_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.session).toMatchObject({ sessionId: SESSION_ID, tenantId: 'wain' });
      expect(body.runs).toEqual([]);       // 无 runStore → 空数组
      expect(body.billing).toBeNull();     // 无 billingService → null
      expect(body.sandboxes).toEqual([]);  // 无 ACS hand → 空数组
    });

    // 关键契约：org-admin 恒带自租户，不是 undefined
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({ tenantId: 'wain' }));
  });

  it('org-admin 跨租户 404：store.get 仍收到自租户 tenantId（非 undefined），命不中返回 404', async () => {
    // wain org-admin 请求 kaiyan 的 session：store 因 tenant 不匹配返回 null
    const get = vi.fn(async (_id: string, opts: { tenantId?: string }) =>
      opts.tenantId === 'kaiyan' ? sessionRecord({ tenantId: 'kaiyan' }) : null);
    const sessionProjectionStore = { get } as any;

    await withApp(WAIN_ADMIN, { sessionProjectionStore }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/sessions/${SESSION_ID}`);
      expect(res.status).toBe(404);
      expect((await res.json() as { error: string }).error).toBe('Session not found');
    });

    // 关键契约：即便跨租户请求，传的仍是 org-admin 自己的 'wain'，绝不回归成 undefined
    expect(get).toHaveBeenCalledTimes(1);
    const opts = get.mock.calls[0]![1] as { tenantId?: string };
    expect(opts.tenantId).toBe('wain');
    expect(opts.tenantId).not.toBeUndefined();
  });

  it('平台 admin 跨租户放行：store.get 收到 tenantId=undefined，返回 200', async () => {
    // pantheon 平台 admin 请求 kaiyan 的 session：tenantId=undefined → 不过滤 → 命中
    const get = vi.fn(async (_id: string, opts: { tenantId?: string }) =>
      opts.tenantId === undefined ? sessionRecord({ tenantId: 'kaiyan' }) : null);
    const sessionProjectionStore = { get } as any;

    await withApp(PLATFORM_ADMIN, { sessionProjectionStore }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/sessions/${SESSION_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.session).toMatchObject({ sessionId: SESSION_ID, tenantId: 'kaiyan' });
    });

    // 关键契约：平台 admin 恒传 undefined（by-design 跨租户）
    expect(get).toHaveBeenCalledTimes(1);
    const opts = get.mock.calls[0]![1] as { tenantId?: string };
    expect(opts.tenantId).toBeUndefined();
    expect('tenantId' in opts).toBe(true); // 传的是 undefined 而非省略键
  });

  it('P2 billing 服务 reject 仍 200，billing 降级为 null（不阻塞 session 详情）', async () => {
    const get = vi.fn(async () => sessionRecord({ tenantId: 'kaiyan' }));
    const billingService = {
      getSessionSummary: vi.fn(async () => { throw new Error('billing backend down'); }),
    } as any;

    await withApp(PLATFORM_ADMIN, { sessionProjectionStore: { get } as any, billingService }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/sessions/${SESSION_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.session).toMatchObject({ sessionId: SESSION_ID });
      expect(body.billing).toBeNull();
    });

    expect(billingService.getSessionSummary).toHaveBeenCalledTimes(1);
  });
});

function sessionRecord(input: { tenantId: string }): RuntimeSessionProjectionRecord {
  return {
    sessionId: SESSION_ID,
    tenantId: input.tenantId,
    userId: 'u-1',
    username: 'alice',
    channel: 'web',
    kind: 'user',
    title: 'Test session',
    runtimeStatus: 'idle',
    createdAt: '2026-07-06T10:00:00.000Z',
    updatedAt: '2026-07-06T10:01:00.000Z',
    metaJson: {
      userId: 'u-1',
      username: 'alice',
      tenantId: input.tenantId,
      channel: 'web',
      createdAt: '2026-07-06T10:00:00.000Z',
    },
  };
}
