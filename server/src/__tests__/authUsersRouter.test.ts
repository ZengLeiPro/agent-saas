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

interface TestRig {
  users: {
    platformAdmin: UserInfo;
    wainAdminA: UserInfo;
    wainAdminB: UserInfo;
    wainUser: UserInfo;
  };
  setCaller(user: UserInfo): void;
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
  const tmpRoot = mkdtempSync(join(tmpdir(), "auth-users-router-"));
  const tenantStore = new TenantStore(join(tmpRoot, "tenants.json"));
  await tenantStore.create({
    id: DEFAULT_TENANT_ID,
    name: "万神殿",
    createdBy: "system",
  });
  await tenantStore.create({ id: "wain", name: "唯恩", createdBy: "system" });

  const userStore = new UserStore(join(tmpRoot, "users.json"));
  const platformAdmin = await userStore.create({
    username: "platform_admin",
    password: "password123",
    role: "admin",
    createdBy: "system",
    tenantId: DEFAULT_TENANT_ID,
  });
  const wainAdminA = await userStore.create({
    username: "wain_admin_a",
    password: "password123",
    role: "admin",
    createdBy: "system",
    tenantId: "wain",
  });
  const wainAdminB = await userStore.create({
    username: "wain_admin_b",
    password: "password123",
    role: "admin",
    createdBy: "system",
    tenantId: "wain",
  });
  const wainUser = await userStore.create({
    username: "wain_user",
    password: "password123",
    role: "user",
    createdBy: "system",
    tenantId: "wain",
  });

  const app = express();
  app.use(express.json());
  let currentCaller = asCaller(platformAdmin);
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
      loginLogFilePath: join(tmpRoot, "login.jsonl"),
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
    users: { platformAdmin, wainAdminA, wainAdminB, wainUser },
    setCaller(user) {
      currentCaller = asCaller(user);
    },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

describe("auth users router admin boundaries", () => {
  let h: TestRig;

  beforeEach(async () => {
    h = await makeTestRig();
  });

  afterEach(async () => {
    await h.close();
  });

  it("组织 admin 不能修改同租户其他 admin", async () => {
    h.setCaller(h.users.wainAdminA);
    const res = await h.request(`/api/auth/users/${h.users.wainAdminB.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ realName: "被篡改" }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "组织管理员不能管理其他管理员",
    });
  });

  it("组织 admin 可以修改本租户普通用户", async () => {
    h.setCaller(h.users.wainAdminA);
    const res = await h.request(`/api/auth/users/${h.users.wainUser.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ realName: "普通用户" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: h.users.wainUser.id,
      realName: "普通用户",
    });
  });

  it("组织 admin 不能删除同租户其他 admin", async () => {
    h.setCaller(h.users.wainAdminA);
    const res = await h.request(`/api/auth/users/${h.users.wainAdminB.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "组织管理员不能管理其他管理员",
    });
  });

  it("组织 admin 不能禁用同租户其他 admin", async () => {
    h.setCaller(h.users.wainAdminA);
    const res = await h.request(
      `/api/auth/users/${h.users.wainAdminB.id}/status`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      },
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "组织管理员不能管理其他管理员",
    });
  });

  it("admin 不能删除或降级自己", async () => {
    h.setCaller(h.users.wainAdminA);
    const deleteSelf = await h.request(
      `/api/auth/users/${h.users.wainAdminA.id}`,
      { method: "DELETE" },
    );
    expect(deleteSelf.status).toBe(400);
    await expect(deleteSelf.json()).resolves.toMatchObject({
      error: "不能删除自己",
    });

    const downgradeSelf = await h.request(
      `/api/auth/users/${h.users.wainAdminA.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user" }),
      },
    );
    expect(downgradeSelf.status).toBe(400);
    await expect(downgradeSelf.json()).resolves.toMatchObject({
      error: "不能降级自己",
    });
  });

  it("平台 admin 可以修改租户 admin", async () => {
    h.setCaller(h.users.platformAdmin);
    const res = await h.request(`/api/auth/users/${h.users.wainAdminB.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ realName: "平台已修改" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: h.users.wainAdminB.id,
      realName: "平台已修改",
    });
  });
});
