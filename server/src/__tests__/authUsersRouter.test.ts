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
import {
  VerificationCodeService,
  type SmsSender,
} from "../integrations/sms/verificationService.js";

class CaptureSender implements SmsSender {
  readonly providerName = "capture";
  lastPhone = "";
  lastCode = "";

  async sendCode(phone: string, code: string): Promise<void> {
    this.lastPhone = phone;
    this.lastCode = code;
  }
}

interface TestRig {
  users: {
    platformAdmin: UserInfo;
    wainAdminA: UserInfo;
    wainAdminB: UserInfo;
    wainUser: UserInfo;
  };
  sender: CaptureSender;
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
    phone: "13800001111",
    phoneVerifiedAt: new Date().toISOString(),
  });
  const sender = new CaptureSender();

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
      loginCodeService: new VerificationCodeService({ sender }),
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
    sender,
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

  it("短信验证码登录签发 token，验证码只能消费一次", async () => {
    const send = await h.request("/api/auth/sms/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800001111" }),
    });
    expect(send.status).toBe(200);
    expect(h.sender.lastPhone).toBe("13800001111");
    expect(h.sender.lastCode).toMatch(/^\d{6}$/);

    const login = await h.request("/api/auth/sms/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: "13800001111",
        code: h.sender.lastCode,
      }),
    });
    expect(login.status).toBe(200);
    const data = (await login.json()) as {
      token: string;
      user: { id: string; username: string; tenantId: string; phone?: string };
    };
    expect(data.token).toBeTruthy();
    expect(data.user).toMatchObject({
      id: h.users.wainUser.id,
      username: "wain_user",
      tenantId: "wain",
      phone: "13800001111",
    });

    const replay = await h.request("/api/auth/sms/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: "13800001111",
        code: h.sender.lastCode,
      }),
    });
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({
      error: "验证码错误或已过期",
    });
  });

  it("当前用户不能把手机号改成平台已有手机号", async () => {
    h.setCaller(h.users.wainAdminA);
    const res = await h.request("/api/auth/me/phone", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800001111" }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "手机号已存在",
    });
  });

  it("未验证手机号不能用于短信登录", async () => {
    h.setCaller(h.users.wainAdminA);
    const setPhone = await h.request("/api/auth/me/phone", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13900001111" }),
    });
    expect(setPhone.status).toBe(200);

    const send = await h.request("/api/auth/sms/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13900001111" }),
    });
    expect(send.status).toBe(403);
    await expect(send.json()).resolves.toMatchObject({
      code: "PHONE_NOT_VERIFIED",
    });
  });
});
