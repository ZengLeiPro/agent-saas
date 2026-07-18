/**
 * Auth 跨租户隔离防回归测试（auth.ts）
 *
 * 背景：authUsersRouter.test.ts / authRoutesCoverage.test.ts 的 rig 只建了
 * pantheon + wain 两个租户，且所有非平台用户都在 wain。既有 403 用例走的全是
 * **同租户 peerAdmin**（tenantAdminPeerAdminError）这条线，`target.tenantId !==
 * req.user.tenantId` 这条**真正的跨租户隔离线从未被执行**——删掉守卫既有测试全绿。
 *
 * 本文件新增第三个租户 `acme`，构造「A 租户 admin（wainAdmin，非平台 admin）
 * 操作 B 租户（acme）用户」，专门锁定「跨组织访问被拒绝」这条线：
 *  - PATCH  /users/:id          跨租户改用户 → 403 且目标未被改
 *  - DELETE /users/:id          跨租户删用户 → 403 且目标仍存在
 *  - PATCH  /users/:id/status   跨租户禁用   → 403 且目标 disabled 未变
 *  - POST   /users/:id/avatar   跨租户改头像 → 403（该路由此前零测试；顺带补同租户 200 正路径）
 *  - GET    /login-logs         组织 admin 传 ?tenantId=<他租户> 被强制回本租户，不泄漏他人日志
 * 并补一条平台 admin 跨租户放行的对照。
 *
 * 模式对齐 authUsersRouter.test.ts：真实 UserStore/TenantStore + 真 express +
 * listen(0) + 真 fetch；rig 直接 req.user = currentCaller 注入调用方。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JwtPayload } from "../auth/types.js";
import { DEFAULT_TENANT_ID } from "../data/tenants/types.js";
import { TenantStore } from "../data/tenants/store.js";
import { UserStore } from "../data/users/store.js";
import type { UserInfo } from "../data/users/types.js";
import { createAuthRouter } from "../routes/auth.js";
import { appendLoginLog } from "../data/login-logs/store.js";

interface TestRig {
  users: {
    platformAdmin: UserInfo;
    wainAdmin: UserInfo;
    acmeUser: UserInfo;
    acmeAdmin: UserInfo;
  };
  userStore: UserStore;
  loginLogFilePath: string;
  setCaller(user: UserInfo | undefined): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

function asCaller(user: UserInfo): JwtPayload {
  return {
    sub: user.id,
    username: user.username,
    role: user.role,
    tenantId: user.tenantId,
  };
}

async function makeTestRig(): Promise<TestRig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "auth-tenant-iso-"));
  const tenantStore = new TenantStore(join(tmpRoot, "tenants.json"));
  await tenantStore.create({
    id: DEFAULT_TENANT_ID,
    name: "万神殿",
    createdBy: "system",
  });
  await tenantStore.create({ id: "wain", name: "唯恩", createdBy: "system" });
  // 第三个非默认租户：构造真正的 A(wain) → B(acme) 跨租户场景
  await tenantStore.create({ id: "acme", name: "阿康", createdBy: "system" });

  const userStore = new UserStore(join(tmpRoot, "users.json"));
  const platformAdmin = await userStore.create({
    username: "platform_admin",
    password: "password123",
    role: "admin",
    createdBy: "system",
    tenantId: DEFAULT_TENANT_ID,
  });
  // A 租户 admin（非平台 admin）——本文件所有跨租户攻击的发起方
  const wainAdmin = await userStore.create({
    username: "wain_admin",
    password: "password123",
    role: "admin",
    createdBy: "system",
    tenantId: "wain",
  });
  // B 租户普通用户——跨租户操作的目标
  const acmeUser = await userStore.create({
    username: "acme_user",
    password: "password123",
    role: "user",
    createdBy: "system",
    tenantId: "acme",
  });
  // B 租户 admin——供「同租户改头像 200」正路径复用
  const acmeAdmin = await userStore.create({
    username: "acme_admin",
    password: "password123",
    role: "admin",
    createdBy: "system",
    tenantId: "acme",
  });

  const loginLogFilePath = join(tmpRoot, "login.jsonl");
  const app = express();
  app.use(express.json());
  let currentCaller: JwtPayload | undefined = asCaller(platformAdmin);
  app.use((req, _res, next) => {
    req.user = currentCaller;
    next();
  });
  app.use(
    "/api/auth",
    createAuthRouter({
      userStore,
      tenantStore,
      jwtSecret: "test-secret",
      tokenExpiresIn: "1h",
      avatarsDir: join(tmpRoot, "avatars"),
      loginLogFilePath,
      agentCwd: join(tmpRoot, "workspaces"),
      sharedDir: join(tmpRoot, "shared"),
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const baseUrl =
    typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";

  return {
    users: { platformAdmin, wainAdmin, acmeUser, acmeAdmin },
    userStore,
    loginLogFilePath,
    setCaller(user) {
      currentCaller = user ? asCaller(user) : undefined;
    },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

/** 1x1 PNG，供头像 multipart 上传使用（合法 image/png，过 multer fileFilter）。 */
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQ" +
  "DJ/AP+AAAAAElFTkSuQmCC";

function pngBlob(): Blob {
  const bytes = Buffer.from(PNG_1X1_BASE64, "base64");
  return new Blob([bytes], { type: "image/png" });
}

describe("auth 跨租户隔离（target.tenantId !== req.user.tenantId 这条线）", () => {
  let h: TestRig;

  beforeEach(async () => {
    h = await makeTestRig();
  });

  afterEach(async () => {
    await h.close();
  });

  it("PATCH /users/:id：组织 admin 不能跨租户改他组织用户 → 403，且目标未被改", async () => {
    h.setCaller(h.users.wainAdmin);
    const res = await h.request(`/api/auth/users/${h.users.acmeUser.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ realName: "跨租户篡改" }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "跨组织访问被拒绝",
    });
    // 隔离生效：目标用户未被写入
    const after = h.userStore.findById(h.users.acmeUser.id);
    expect(after?.realName).toBeUndefined();
  });

  it("DELETE /users/:id：组织 admin 不能跨租户删他组织用户 → 403，且目标仍存在", async () => {
    h.setCaller(h.users.wainAdmin);
    const res = await h.request(`/api/auth/users/${h.users.acmeUser.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "跨组织访问被拒绝",
    });
    // 隔离生效：目标用户未被删除
    expect(h.userStore.findById(h.users.acmeUser.id)).toBeTruthy();
  });

  it("PATCH /users/:id/status：组织 admin 不能跨租户禁用他组织用户 → 403，且 disabled 未变", async () => {
    h.setCaller(h.users.wainAdmin);
    const res = await h.request(
      `/api/auth/users/${h.users.acmeUser.id}/status`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      },
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "跨组织访问被拒绝",
    });
    // 隔离生效：目标未被禁用
    expect(h.userStore.findById(h.users.acmeUser.id)?.disabled).toBeFalsy();
  });

  it("POST /users/:id/avatar：组织 admin 不能跨租户改他组织用户头像 → 403", async () => {
    h.setCaller(h.users.wainAdmin);
    const form = new FormData();
    form.append("avatar", pngBlob(), "a.png");
    const res = await h.request(
      `/api/auth/users/${h.users.acmeUser.id}/avatar`,
      { method: "POST", body: form },
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "跨组织访问被拒绝",
    });
    // 隔离生效：目标 avatar 未被写入
    expect(h.userStore.findById(h.users.acmeUser.id)?.avatar).toBeFalsy();
  });

  it("POST /users/:id/avatar：同租户 admin 给本组织用户改头像 → 200（正路径，此前零测试）", async () => {
    h.setCaller(h.users.acmeAdmin);
    const form = new FormData();
    form.append("avatar", pngBlob(), "a.png");
    const res = await h.request(
      `/api/auth/users/${h.users.acmeUser.id}/avatar`,
      { method: "POST", body: form },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      avatar: string;
      avatarVersion: number;
    };
    expect(body.avatar).toContain(`/api/auth/avatar/${h.users.acmeUser.id}`);
    expect(h.userStore.findById(h.users.acmeUser.id)?.avatar).toBeTruthy();
  });

  it("GET /login-logs：组织 admin 传 ?tenantId=<他租户> 被强制回本租户，不泄漏他人日志", async () => {
    // 播种跨租户日志：一条 wain、一条 acme
    await appendLoginLog(
      {
        timestamp: new Date().toISOString(),
        event: "page_viewed",
        username: "wain_user",
        tenantId: "wain",
        ip: "1.1.1.1",
        userAgent: "test",
        channel: "web",
      },
      h.loginLogFilePath,
    );
    await appendLoginLog(
      {
        timestamp: new Date().toISOString(),
        event: "page_viewed",
        username: "acme_user",
        tenantId: "acme",
        ip: "2.2.2.2",
        userAgent: "test",
        channel: "web",
      },
      h.loginLogFilePath,
    );

    // 组织 admin 显式请求他租户 → query.tenantId 被忽略，强制回本租户 wain
    h.setCaller(h.users.wainAdmin);
    const res = await h.request("/api/auth/login-logs?tenantId=acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ tenantId?: string }>;
      total: number;
    };
    // 只应看到本租户 wain 的日志，绝不含 acme
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.every((e) => e.tenantId === "wain")).toBe(true);
    expect(body.entries.some((e) => e.tenantId === "acme")).toBe(false);
  });

  it("GET /login-logs：平台 admin 跨租户放行，可查他租户日志（对照）", async () => {
    await appendLoginLog(
      {
        timestamp: new Date().toISOString(),
        event: "page_viewed",
        username: "acme_user",
        tenantId: "acme",
        ip: "2.2.2.2",
        userAgent: "test",
        channel: "web",
      },
      h.loginLogFilePath,
    );

    h.setCaller(h.users.platformAdmin);
    const res = await h.request("/api/auth/login-logs?tenantId=acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ tenantId?: string }>;
      total: number;
    };
    // 平台 admin 放行：能看到 acme 日志
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.every((e) => e.tenantId === "acme")).toBe(true);
  });

  it("对照：平台 admin 可跨租户改他组织用户 → 200（放行线，区别于组织 admin 403）", async () => {
    h.setCaller(h.users.platformAdmin);
    const res = await h.request(`/api/auth/users/${h.users.acmeUser.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ realName: "平台已修改" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: h.users.acmeUser.id,
      realName: "平台已修改",
    });
  });
});
