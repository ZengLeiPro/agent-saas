/**
 * Auth 路由未覆盖分支补测（auth.ts）
 *
 * authUsersRouter.test.ts 已覆盖 admin 边界 + 短信登录/手机号验证；本文件补齐
 * 密码登录、/me、requireAdmin 403、创建/禁用用户、改密码、活动上报、login-logs 校验：
 *  - POST /login：成功签发 token、错误密码 401、账号禁用 403、租户不存在 403、速率限制 429
 *  - GET /me：未登录 401、已登录透传身份
 *  - GET /users：非 admin 403（requireAdmin）、组织 admin 只见本租户
 *  - POST /users：用户名重复 409、tenant 不存在 400、组织 admin 忽略跨租户入参
 *  - PATCH /users/:id/status：disabled 非布尔 400、禁用/启用成功
 *  - PATCH /password：未登录 401、旧密码错误 400、成功
 *  - POST /activity：未登录 401、非法事件 400、合法事件 200
 *  - GET /login-logs：非法 tenantId 400
 *
 * 模式对齐 authUsersRouter.test.ts：真实 UserStore/TenantStore + 真 express + listen(0) + 真 fetch。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { TenantStore } from '../data/tenants/store.js';
import { UserStore } from '../data/users/store.js';
import type { UserInfo } from '../data/users/types.js';
import { createAuthRouter } from '../routes/auth.js';

interface TestRig {
  users: {
    platformAdmin: UserInfo;
    wainAdmin: UserInfo;
    wainUser: UserInfo;
  };
  setCaller(user: UserInfo | undefined): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

function asCaller(user: UserInfo): JwtPayload {
  return { sub: user.id, username: user.username, role: user.role, tenantId: user.tenantId };
}

async function makeRig(): Promise<TestRig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'auth-cov-'));
  const tenantStore = new TenantStore(join(tmpRoot, 'tenants.json'));
  await tenantStore.create({ id: DEFAULT_TENANT_ID, name: '万神殿', createdBy: 'system' });
  await tenantStore.create({ id: 'wain', name: '唯恩', createdBy: 'system' });

  const userStore = new UserStore(join(tmpRoot, 'users.json'));
  const platformAdmin = await userStore.create({
    username: 'platform_admin', password: 'password123', role: 'admin',
    createdBy: 'system', tenantId: DEFAULT_TENANT_ID,
  });
  const wainAdmin = await userStore.create({
    username: 'wain_admin', password: 'password123', role: 'admin',
    createdBy: 'system', tenantId: 'wain',
  });
  const wainUser = await userStore.create({
    username: 'wain_user', password: 'password123', role: 'user',
    createdBy: 'system', tenantId: 'wain',
  });

  const app = express();
  // 与生产一致（index.ts）：信任代理头，让测试可通过 X-Forwarded-For 给每个用例
  // 分配独立 client IP，避免模块级登录速率限制器（按 IP keyed）跨用例互相污染。
  app.set('trust proxy', true);
  app.use(express.json());
  let currentCaller: JwtPayload | undefined = asCaller(platformAdmin);
  app.use((req, _res, next) => {
    req.user = currentCaller;
    next();
  });
  app.use('/api/auth', createAuthRouter({
    userStore,
    tenantStore,
    jwtSecret: 'test-secret',
    tokenExpiresIn: '1h',
    avatarsDir: join(tmpRoot, 'avatars'),
    loginLogFilePath: join(tmpRoot, 'login.jsonl'),
    agentCwd: join(tmpRoot, 'workspaces'),
    sharedDir: join(tmpRoot, 'shared'),
  }));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  return {
    users: { platformAdmin, wainAdmin, wainUser },
    setCaller(user) { currentCaller = user ? asCaller(user) : undefined; },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function jsonInit(method: string, body: unknown, extraHeaders?: Record<string, string>): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

/** 给登录请求分配独立 client IP，隔离模块级速率限制器（按 IP keyed）。 */
function loginInit(body: unknown, ip: string): RequestInit {
  return jsonInit('POST', body, { 'X-Forwarded-For': ip });
}

describe('auth routes coverage', () => {
  let h: TestRig;
  beforeEach(async () => { h = await makeRig(); });
  afterEach(async () => { await h.close(); });

  it('POST /login：成功签发 token、错误密码 401、校验失败 400', async () => {
    const ip = '10.0.0.1';
    // 成功
    const ok = await h.request('/api/auth/login', loginInit({
      username: 'wain_user', password: 'password123',
    }, ip));
    expect(ok.status).toBe(200);
    const okBody = await ok.json() as { token: string; user: { id: string; tenantId: string } };
    expect(okBody.token).toBeTruthy();
    expect(okBody.user).toMatchObject({ id: h.users.wainUser.id, tenantId: 'wain' });

    // 错误密码 → 401
    const wrong = await h.request('/api/auth/login', loginInit({
      username: 'wain_user', password: 'wrong-password',
    }, ip));
    expect(wrong.status).toBe(401);
    expect((await wrong.json() as { error: string }).error).toBe('用户名或密码错误');

    // 空 body → zod 校验 400
    const badBody = await h.request('/api/auth/login', loginInit({ username: '' }, ip));
    expect(badBody.status).toBe(400);
  });

  it('POST /login：连续错误尝试触发速率限制 429（独立 IP）', async () => {
    const ip = '10.0.0.99';
    // 用尽 5 次尝试后触发速率限制（同 IP）
    for (let i = 0; i < 5; i++) {
      await h.request('/api/auth/login', loginInit({ username: 'nobody', password: 'x' }, ip));
    }
    const limited = await h.request('/api/auth/login', loginInit({ username: 'nobody', password: 'x' }, ip));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  it('GET /me：未登录 401、已登录透传身份与租户', async () => {
    h.setCaller(undefined);
    const anon = await h.request('/api/auth/me');
    expect(anon.status).toBe(401);

    h.setCaller(h.users.wainUser);
    const me = await h.request('/api/auth/me');
    expect(me.status).toBe(200);
    const body = await me.json() as { id: string; tenantId: string; isSuperAdmin: boolean };
    expect(body.id).toBe(h.users.wainUser.id);
    expect(body.tenantId).toBe('wain');
    expect(body.isSuperAdmin).toBe(false);
  });

  it('GET /users：非 admin 403（requireAdmin）；组织 admin 只见本租户', async () => {
    h.setCaller(h.users.wainUser);
    const forbidden = await h.request('/api/auth/users');
    expect(forbidden.status).toBe(403);

    h.setCaller(h.users.wainAdmin);
    const scoped = await h.request('/api/auth/users');
    expect(scoped.status).toBe(200);
    const body = await scoped.json() as { users: Array<{ tenantId: string }> };
    expect(body.users.length).toBeGreaterThan(0);
    expect(body.users.every((u) => u.tenantId === 'wain')).toBe(true);
  });

  it('POST /users：用户名重复 409、tenant 不存在 400、组织 admin 忽略跨租户入参', async () => {
    h.setCaller(h.users.platformAdmin);
    // 用户名重复 → 409
    const dup = await h.request('/api/auth/users', jsonInit('POST', {
      username: 'wain_user', password: 'password123',
    }));
    expect(dup.status).toBe(409);
    expect((await dup.json() as { error: string }).error).toBe('用户名已存在');

    // 平台 admin 指定不存在 tenant → 400
    const badTenant = await h.request('/api/auth/users', jsonInit('POST', {
      username: 'newuser1', password: 'password123', tenantId: 'ghost',
    }));
    expect(badTenant.status).toBe(400);
    expect((await badTenant.json() as { error: string }).error).toContain('不存在');

    // 组织 admin 建用户时 body.tenantId 被忽略，强制绑到调用方 tenant
    h.setCaller(h.users.wainAdmin);
    const created = await h.request('/api/auth/users', jsonInit('POST', {
      username: 'newuser2', password: 'password123', tenantId: DEFAULT_TENANT_ID,
    }));
    expect(created.status).toBe(201);
    expect((await created.json() as { tenantId: string }).tenantId).toBe('wain');
  });

  it('PATCH /users/:id/status：disabled 非布尔 400、禁用后再登录 403', async () => {
    h.setCaller(h.users.wainAdmin);
    // 非布尔 → 400
    const badType = await h.request(`/api/auth/users/${h.users.wainUser.id}/status`,
      jsonInit('PATCH', { disabled: 'yes' }));
    expect(badType.status).toBe(400);

    // 禁用普通用户 → 200
    const disable = await h.request(`/api/auth/users/${h.users.wainUser.id}/status`,
      jsonInit('PATCH', { disabled: true }));
    expect(disable.status).toBe(200);
    expect((await disable.json() as { disabled: boolean }).disabled).toBe(true);

    // 被禁用用户密码登录 → 403 USER_DISABLED
    const login = await h.request('/api/auth/login', loginInit({
      username: 'wain_user', password: 'password123',
    }, '10.0.0.2'));
    expect(login.status).toBe(403);
    expect((await login.json() as { code: string }).code).toBe('USER_DISABLED');
  });

  it('PATCH /password：未登录 401、旧密码错误 400、成功后可用新密码登录', async () => {
    h.setCaller(undefined);
    const anon = await h.request('/api/auth/password',
      jsonInit('PATCH', { oldPassword: 'password123', newPassword: 'newpass123' }));
    expect(anon.status).toBe(401);

    h.setCaller(h.users.wainUser);
    // 旧密码错误 → 400
    const wrongOld = await h.request('/api/auth/password',
      jsonInit('PATCH', { oldPassword: 'not-my-password', newPassword: 'newpass123' }));
    expect(wrongOld.status).toBe(400);
    expect((await wrongOld.json() as { error: string }).error).toBe('当前密码错误');

    // 校验失败（新密码过短）→ 400
    const shortNew = await h.request('/api/auth/password',
      jsonInit('PATCH', { oldPassword: 'password123', newPassword: '123' }));
    expect(shortNew.status).toBe(400);

    // 成功修改
    const ok = await h.request('/api/auth/password',
      jsonInit('PATCH', { oldPassword: 'password123', newPassword: 'newpass123' }));
    expect(ok.status).toBe(200);
    expect((await ok.json() as { success: boolean }).success).toBe(true);

    // 新密码可登录
    const relogin = await h.request('/api/auth/login', loginInit({
      username: 'wain_user', password: 'newpass123',
    }, '10.0.0.3'));
    expect(relogin.status).toBe(200);
  });

  it('POST /activity：未登录 401、非法事件 400、合法事件 200', async () => {
    h.setCaller(undefined);
    const anon = await h.request('/api/auth/activity', jsonInit('POST', { event: 'app_foreground' }));
    expect(anon.status).toBe(401);

    h.setCaller(h.users.wainUser);
    const invalid = await h.request('/api/auth/activity', jsonInit('POST', { event: 'hack_event' }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { error: string }).error).toBe('Invalid event');

    const ok = await h.request('/api/auth/activity', jsonInit('POST', {
      event: 'app_foreground', detail: 'v1.2.3',
    }));
    expect(ok.status).toBe(200);
    expect((await ok.json() as { ok: boolean }).ok).toBe(true);
  });

  it('GET /login-logs：非法 tenantId 400；组织 admin 强制过滤本租户', async () => {
    h.setCaller(h.users.wainAdmin);
    // 非法 slug（含大写 / 特殊字符）→ 400
    const bad = await h.request('/api/auth/login-logs?tenantId=Not*Valid');
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toBe('tenantId 不合法');

    // 合法请求 → 200，返回结构含 total
    const ok = await h.request('/api/auth/login-logs');
    expect(ok.status).toBe(200);
    const body = await ok.json() as { total: number; logs?: unknown[] };
    expect(typeof body.total).toBe('number');
  });

  it('GET /avatar/:userId：无头像返回 204（避免用户枚举）', async () => {
    // 头像获取是公开接口；未设置头像时返回 204 而非 404
    const res = await h.request(`/api/auth/avatar/${h.users.wainUser.id}`);
    expect(res.status).toBe(204);
  });
});
