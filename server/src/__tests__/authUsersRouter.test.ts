import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JwtPayload } from "../auth/types.js";
import { AuthEpochAuthority } from "../auth/authEpochAuthority.js";
import { PLATFORM_CAPABILITIES } from "../../../shared/src/types/user.js";
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
    superAdmin: UserInfo;
    platformAdmin: UserInfo;
    platformAdminB: UserInfo;
    wainAdminA: UserInfo;
    wainAdminB: UserInfo;
    wainUser: UserInfo;
  };
  userStore: UserStore;
  tenantStore: TenantStore;
  sender: CaptureSender;
  tenantChanges: UserInfo[];
  userDeletes: UserInfo[];
  fencedUserIds: string[];
  authEpochAuthority: AuthEpochAuthority;
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
    platformCapabilities: user.platformCapabilities,
    platformCapabilityLimits: user.platformCapabilityLimits,
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
  await tenantStore.create({ id: "other", name: "其他组织", createdBy: "system" });

  const userStore = new UserStore(join(tmpRoot, "users.json"));
  const superAdmin = await userStore.create({
    username: "admin",
    password: "password123",
    role: "admin",
    createdBy: "system",
    tenantId: DEFAULT_TENANT_ID,
  });
  const platformAdmin = await userStore.create({
    username: "platform_admin",
    password: "password123",
    role: "admin",
    createdBy: "system",
    tenantId: DEFAULT_TENANT_ID,
  });
  const platformAdminB = await userStore.create({
    username: "platform_admin_b",
    password: "password123",
    role: "admin",
    createdBy: "system",
    tenantId: DEFAULT_TENANT_ID,
    phone: "13912345678",
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
  const tenantChanges: UserInfo[] = [];
  const userDeletes: UserInfo[] = [];
  const fencedUserIds: string[] = [];
  const authEpochAuthority = new AuthEpochAuthority(join(tmpRoot, "auth-epochs.json"));

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
      loginCodeService: new VerificationCodeService({ sender, cooldownMs: 0 }),
      authEpochAuthority,
      onAuthFenced: async userId => { fencedUserIds.push(userId); },
      onUserTenantChanging: async user => { tenantChanges.push({ ...user }); },
      onUserDeleting: async user => { userDeletes.push({ ...user }); },
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const baseUrl =
    typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";

  return {
    users: { superAdmin, platformAdmin, platformAdminB, wainAdminA, wainAdminB, wainUser },
    userStore,
    tenantStore,
    sender,
    tenantChanges,
    userDeletes,
    fencedUserIds,
    authEpochAuthority,
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

  it("上级未开放时拒绝为成员开启调试模式", async () => {
    h.setCaller(h.users.wainAdminA);
    const res = await h.request(`/api/auth/users/${h.users.wainUser.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ debugMode: true }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "上级未开放调试模式，不能为成员开启",
    });
    expect(h.userStore.findById(h.users.wainUser.id)?.debugMode).toBe(false);
  });

  it("登录态只返回三级开关共同决定的有效值", async () => {
    await h.userStore.update(h.users.wainUser.id, { debugMode: true });
    h.setCaller(h.users.wainUser);

    const closed = await h.request("/api/auth/me");
    expect(closed.status).toBe(200);
    await expect(closed.json()).resolves.toMatchObject({ debugMode: false });

    const current = h.tenantStore.getSettings("wain")!;
    await h.tenantStore.updateSettings("wain", {
      features: {
        ...current.features,
        debugModeAllowed: true,
        debugModeEnabled: true,
      },
    });
    const opened = await h.request("/api/auth/me");
    expect(opened.status).toBe(200);
    await expect(opened.json()).resolves.toMatchObject({ debugMode: true });
  });

  it("成员 PATCH 响应返回三级继承后的有效调试模式", async () => {
    await h.userStore.update(h.users.wainUser.id, { debugMode: true });
    h.setCaller(h.users.wainAdminA);

    const response = await h.request(`/api/auth/users/${h.users.wainUser.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ realName: "成员一" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ debugMode: false });
  });

  it("成员通过本人设置 API 开关且保存后立即返回有效值", async () => {
    h.setCaller(h.users.wainUser);
    const blocked = await h.request("/api/auth/me/debug-mode", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ debugMode: true }),
    });
    expect(blocked.status).toBe(400);
    await expect(blocked.json()).resolves.toMatchObject({ error: "上级未开放调试模式，不能为本人开启" });

    const current = h.tenantStore.getSettings("wain")!;
    await h.tenantStore.updateSettings("wain", {
      features: { ...current.features, debugModeAllowed: true, debugModeEnabled: true },
    });
    const opened = await h.request("/api/auth/me/debug-mode", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ debugMode: true }),
    });
    expect(opened.status).toBe(200);
    await expect(opened.json()).resolves.toMatchObject({ debugMode: true });
    expect(h.userStore.findById(h.users.wainUser.id)?.debugMode).toBe(true);

    const closed = await h.request("/api/auth/me/debug-mode", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ debugMode: false }),
    });
    expect(closed.status).toBe(200);
    await expect(closed.json()).resolves.toMatchObject({ debugMode: false });
    expect(h.userStore.findById(h.users.wainUser.id)?.debugMode).toBe(false);
  });

  it("本人设置 API 不接受其他 userId 或修改其他成员", async () => {
    h.setCaller(h.users.wainUser);
    const response = await h.request("/api/auth/me/debug-mode", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ debugMode: true, userId: h.users.wainAdminA.id }),
    });
    expect(response.status).toBe(400);
    expect(h.userStore.findById(h.users.wainAdminA.id)?.debugMode).toBe(false);
  });

  it("组织关闭时清理成员开关并持久化为 false", async () => {
    const current = h.tenantStore.getSettings("wain")!;
    await h.tenantStore.updateSettings("wain", {
      features: { ...current.features, debugModeAllowed: true, debugModeEnabled: true },
    });
    await h.userStore.update(h.users.wainUser.id, { debugMode: true });
    await h.userStore.disableDebugModeForTenant("wain");
    expect(h.userStore.findById(h.users.wainUser.id)?.debugMode).toBe(false);
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

  it("删除最后有效管理员时先拒绝，不触发外部清理副作用", async () => {
    await h.userStore.setDisabled(
      h.users.wainAdminB.id,
      true,
      h.users.platformAdmin.id,
    );
    h.setCaller(h.users.platformAdmin);
    const res = await h.request(`/api/auth/users/${h.users.wainAdminA.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Cannot delete the last admin" });
    expect(h.userDeletes).toHaveLength(0);
    expect(h.userStore.findById(h.users.wainAdminA.id)).toBeTruthy();
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

  it("通用用户 PATCH 拒绝跨组织迁移，且不触发旧租户清理副作用", async () => {
    h.setCaller(h.users.superAdmin);
    const res = await h.request(`/api/auth/users/${h.users.wainUser.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: "other" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "通用用户接口不支持跨组织迁移，请使用专用迁移流程",
    });
    expect(h.tenantChanges).toHaveLength(0);
  });

  it("万神殿账号不能通过通用 PATCH 降级为普通成员", async () => {
    h.setCaller(h.users.platformAdmin);
    const res = await h.request(`/api/auth/users/${h.users.platformAdminB.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "user" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "万神殿只允许平台管理员" });
  });

  it("平台管理员可管理客户账号和其他万神殿账号", async () => {
    h.setCaller(h.users.platformAdmin);
    const customer = await h.request(`/api/auth/users/${h.users.wainUser.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ realName: "客户账号已更新" }),
    });
    expect(customer.status).toBe(200);

    const pantheon = await h.request(`/api/auth/users/${h.users.platformAdminB.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ realName: "平台同事已更新" }),
    });
    expect(pantheon.status).toBe(200);
    await expect(pantheon.json()).resolves.toMatchObject({
      realName: "平台同事已更新",
    });
  });

  it("平台管理员列表返回完整手机号", async () => {
    h.setCaller(h.users.platformAdmin);
    const res = await h.request("/api/auth/users");
    expect(res.status).toBe(200);
    const { users } = await res.json() as {
      users: Array<{ id: string; phone?: string; phoneVerifiedAt?: string }>;
    };
    const target = users.find((user) => user.id === h.users.platformAdminB.id);
    expect(target?.phone).toBe("13912345678");
  });

  it("平台管理员通过专用接口重置密码并撤销旧登录态", async () => {
    h.setCaller({ ...h.users.platformAdmin, platformCapabilities: [] });
    const oldBinding = h.authEpochAuthority.issueLogin(h.users.wainUser.id);
    const res = await h.request(`/api/auth/users/${h.users.wainUser.id}/password`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: "newpass123" }),
    });
    expect(res.status).toBe(200);
    await expect(h.userStore.verifyPassword("wain_user", "password123")).resolves.toBeNull();
    await expect(h.userStore.verifyPassword("wain_user", "newpass123")).resolves.toBeTruthy();
    expect(h.authEpochAuthority.validates(h.users.wainUser.id, oldBinding)).toBe(false);
    expect(h.fencedUserIds).toContain(h.users.wainUser.id);
  });

  it("兼容通用用户更新接口重置密码时同样撤销旧登录态", async () => {
    h.setCaller(h.users.platformAdmin);
    const oldBinding = h.authEpochAuthority.issueLogin(h.users.wainUser.id);
    const res = await h.request(`/api/auth/users/${h.users.wainUser.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "compatpass123" }),
    });
    expect(res.status).toBe(200);
    expect(h.authEpochAuthority.validates(h.users.wainUser.id, oldBinding)).toBe(false);
    expect(h.fencedUserIds).toContain(h.users.wainUser.id);
  });

  it("兼容 capability 字段仍校验 billing.adjust 双限额，但不影响实际权限", async () => {
    h.setCaller(h.users.platformAdminB);
    const missingLimits = await h.request(`/api/auth/users/${h.users.platformAdmin.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platformCapabilities: ["billing.adjust"] }),
    });
    expect(missingLimits.status).toBe(400);

    const configured = await h.request(`/api/auth/users/${h.users.platformAdmin.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platformCapabilities: PLATFORM_CAPABILITIES,
        platformCapabilityLimits: {
          billingMaxCreditsPerTransaction: 500,
          billingMaxCreditsPerDay: 2_000,
        },
      }),
    });
    expect(configured.status).toBe(200);
    await expect(configured.json()).resolves.toMatchObject({
      platformCapabilities: PLATFORM_CAPABILITIES,
      platformCapabilityLimits: {
        billingMaxCreditsPerTransaction: 500,
        billingMaxCreditsPerDay: 2_000,
      },
    });
  });

  it("用户通过已验证手机号找回密码，验证码只能使用一次且旧登录态失效", async () => {
    const oldBinding = h.authEpochAuthority.issueLogin(h.users.wainUser.id);
    const send = await h.request("/api/auth/password/reset/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800001111" }),
    });
    expect(send.status).toBe(200);

    const wrongPurpose = await h.request("/api/auth/sms/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800001111", code: h.sender.lastCode }),
    });
    expect(wrongPurpose.status).toBe(400);

    const reset = await h.request("/api/auth/password/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: "13800001111",
        code: h.sender.lastCode,
        newPassword: "recovered123",
      }),
    });
    expect(reset.status).toBe(200);
    await expect(h.userStore.verifyPassword("wain_user", "password123")).resolves.toBeNull();
    await expect(h.userStore.verifyPassword("wain_user", "recovered123")).resolves.toBeTruthy();
    expect(h.authEpochAuthority.validates(h.users.wainUser.id, oldBinding)).toBe(false);

    const replay = await h.request("/api/auth/password/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: "13800001111",
        code: h.sender.lastCode,
        newPassword: "another123",
      }),
    });
    expect(replay.status).toBe(400);
  });

  it("找回密码发送接口不泄露手机号注册状态，已知和未知号码同样限频", async () => {
    const requestCode = (phone: string) => h.request("/api/auth/password/reset/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });

    const unknown = await requestCode("13700000000");
    expect(unknown.status).toBe(200);
    await expect(unknown.json()).resolves.toEqual({ ok: true });
    expect((await requestCode("13700000000")).status).toBe(429);

    expect((await requestCode("13800001111")).status).toBe(200);
    expect((await requestCode("13800001111")).status).toBe(429);
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

  it("当前用户不能验证平台已有手机号", async () => {
    h.setCaller(h.users.wainAdminA);
    const res = await h.request("/api/auth/me/phone/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800001111" }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "手机号已存在",
    });
  });

  it("当前用户必须通过验证码验证手机号，验证后可用于短信登录", async () => {
    h.setCaller(h.users.wainAdminA);
    const setPhone = await h.request("/api/auth/me/phone", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13900001111" }),
    });
    expect(setPhone.status).toBe(400);
    await expect(setPhone.json()).resolves.toMatchObject({
      error: "请先通过验证码完成手机号验证",
    });

    const send = await h.request("/api/auth/me/phone/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13900001111" }),
    });
    expect(send.status).toBe(200);
    expect(h.sender.lastPhone).toBe("13900001111");

    const verify = await h.request("/api/auth/me/phone/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: "13900001111",
        code: h.sender.lastCode,
      }),
    });
    expect(verify.status).toBe(200);
    const verified = (await verify.json()) as {
      phone: string;
      phoneVerifiedAt: string;
    };
    expect(verified.phone).toBe("13900001111");
    expect(verified.phoneVerifiedAt).toBeTruthy();

    const sendLoginCode = await h.request("/api/auth/sms/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13900001111" }),
    });
    expect(sendLoginCode.status).toBe(200);

    const login = await h.request("/api/auth/sms/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: "13900001111",
        code: h.sender.lastCode,
      }),
    });
    expect(login.status).toBe(200);
    await expect(login.json()).resolves.toMatchObject({
      user: {
        id: h.users.wainAdminA.id,
        phone: "13900001111",
      },
    });
  });
});
