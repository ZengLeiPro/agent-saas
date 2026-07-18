/**
 * 平台可观测性路由覆盖测试（routes/platformObservability.ts）
 *
 * 现有 platformObservabilityRoutes.test.ts 覆盖了 happy-path 的 SQL 切片，
 * 本文件只补未覆盖的权限门禁与依赖缺失分支（真 express + 真 fetch）：
 *   - 顶层 auth gate：401 未登录 / 403 非 admin
 *   - resolveTenant 跨组织 403（组织 admin 请求他人 tenantId）
 *   - Zod query 校验 400
 *   - 依赖 store 未装配 503（sessions / runs / tool-invocations）
 *   - 平台 admin 门禁 403（overview snapshot / trends 组织 admin 不可访问）
 *   - users/:id/summary 跨组织 404 隐藏 / 404 不存在
 */
import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createPlatformObservabilityRouter } from '../routes/platformObservability.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import type { JwtPayload } from '../auth/types.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'root', username: 'root', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const WAIN_ADMIN: JwtPayload = { sub: 'u-wain-admin', username: 'wain_admin', role: 'admin', tenantId: 'wain' };
const NORMAL_USER: JwtPayload = { sub: 'u-1', username: 'alice', role: 'user', tenantId: 'wain' };

const servers: Server[] = [];

async function withApp<T>(
  user: JwtPayload | undefined,
  options: Partial<Parameters<typeof createPlatformObservabilityRouter>[0]>,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use((req, _res, next) => {
    if (user) req.user = user;
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

describe('platform observability router coverage', () => {
  it('顶层 auth gate：未登录 401，非 admin 用户 403', async () => {
    await withApp(undefined, {}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/users`);
      expect(res.status).toBe(401);
      expect((await res.json() as { error: string }).error).toBe('Authentication required');
    });
    await withApp(NORMAL_USER, {}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/users`);
      expect(res.status).toBe(403);
      expect((await res.json() as { error: string }).error).toBe('Admin access required');
    });
  });

  it('resolveTenant 跨组织 403：组织 admin 请求他人 tenantId', async () => {
    await withApp(WAIN_ADMIN, {}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/tenants/overview?tenantId=kaiyan`);
      expect(res.status).toBe(403);
      expect((await res.json() as { error: string }).error).toBe('Tenant access denied');
    });
  });

  it('Zod query 校验 400：搜索 q 为空 / users limit 越界', async () => {
    await withApp(WAIN_ADMIN, {}, async (baseUrl) => {
      const emptyQ = await fetch(`${baseUrl}/api/admin/search?q=`);
      expect(emptyQ.status).toBe(400);
      expect((await emptyQ.json() as { error: string }).error).toBe('Invalid query');

      const badLimit = await fetch(`${baseUrl}/api/admin/users?limit=9999`);
      expect(badLimit.status).toBe(400);
    });
  });

  it('依赖缺失 503：sessions / runs / tool-invocations 对应 store 未装配', async () => {
    await withApp(WAIN_ADMIN, {}, async (baseUrl) => {
      const sessions = await fetch(`${baseUrl}/api/admin/sessions`);
      expect(sessions.status).toBe(503);
      expect((await sessions.json() as { error: string }).error).toContain('session projection store');

      const runs = await fetch(`${baseUrl}/api/admin/runs`);
      expect(runs.status).toBe(503);
      expect((await runs.json() as { error: string }).error).toContain('run store');

      const tools = await fetch(`${baseUrl}/api/admin/tool-invocations`);
      expect(tools.status).toBe(503);
      expect((await tools.json() as { error: string }).error).toContain('Tool invocation store');
    });
  });

  it('sessions/:id 503：session projection store 未装配', async () => {
    await withApp(PLATFORM_ADMIN, {}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/sessions/11111111-2222-4333-8444-555555555555`);
      expect(res.status).toBe(503);
    });
  });

  it('平台 admin 门禁 403：组织 admin 不能访问 overview snapshot / trends', async () => {
    await withApp(WAIN_ADMIN, {}, async (baseUrl) => {
      const snapshot = await fetch(`${baseUrl}/api/admin/overview/snapshot`);
      expect(snapshot.status).toBe(403);
      expect((await snapshot.json() as { error: string }).error).toBe('Platform admin access required');

      const trends = await fetch(`${baseUrl}/api/admin/overview/trends`);
      expect(trends.status).toBe(403);
      expect((await trends.json() as { error: string }).error).toBe('Platform admin access required');
    });
  });

  it('overview/trends 平台 admin 无数据源时 available=false 并标注 missingSources', async () => {
    await withApp(PLATFORM_ADMIN, {}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/overview/trends?days=7`);
      expect(res.status).toBe(200);
      const body = await res.json() as { available: boolean; missingSources: string[]; daily: unknown[] };
      expect(body.available).toBe(false);
      expect(body.missingSources).toEqual(expect.arrayContaining(['执行记录', '对话']));
      expect(body.daily).toHaveLength(7);
    });
  });

  it('users/:id/summary：不存在 404 / 跨组织 404 隐藏', async () => {
    const userStore = {
      findById: (id: string) => id === 'u-1'
        ? { id, username: 'alice', role: 'user', tenantId: 'wain', createdAt: '', createdBy: 's', updatedAt: '' }
        : undefined,
      listAll: () => [],
    } as any;

    // 不存在的用户 → 404
    await withApp(PLATFORM_ADMIN, { userStore }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/users/does-not-exist/summary`);
      expect(res.status).toBe(404);
    });

    // 组织 admin 查跨组织用户（kaiyan 的 admin 查 wain 的 u-1）→ 404 隐藏
    const KAIYAN_ADMIN: JwtPayload = { sub: 'a', username: 'ka', role: 'admin', tenantId: 'kaiyan' };
    await withApp(KAIYAN_ADMIN, { userStore }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/users/u-1/summary`);
      expect(res.status).toBe(404);
    });
  });

  it('runs：非法 status 白名单外 400', async () => {
    const runStore = { pool: { query: async () => ({ rows: [] }) }, runsTable: 'runtime_runs' } as any;
    await withApp(PLATFORM_ADMIN, { runStore }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/runs?status=bogus-status`);
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toContain('Invalid status');
    });
  });

  it('users 列表：平台 admin 分页返回 items 并可跨组织聚合', async () => {
    const now = '2026-07-06T10:00:00.000Z';
    const mkUser = (id: string, tenantId: string) => ({
      id, username: id, role: 'user', tenantId, createdAt: now, createdBy: 's', updatedAt: now,
    });
    const userStore = {
      findById: () => undefined,
      listAll: () => [mkUser('u-a', 'wain'), mkUser('u-b', 'kaiyan')],
    } as any;
    await withApp(PLATFORM_ADMIN, { userStore }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/users?limit=1`);
      expect(res.status).toBe(200);
      const body = await res.json() as { items: unknown[]; nextCursor?: string };
      expect(body.items).toHaveLength(1);
      // 两个用户 + limit=1 → 有 nextCursor（走 page.length > limit 分支）
      expect(body.nextCursor).toBeTruthy();
    });
  });
});
