import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { JwtPayload } from "../auth/types.js";
import { DEFAULT_TENANT_ID } from "../data/tenants/types.js";
import {
  enforcePlatformWritePolicy,
  getEffectivePlatformCapabilities,
  hasPlatformCapability,
  isSuperAdmin,
  requirePlatformCapability,
  requireSuperAdmin,
} from "../auth/platformGovernance.js";

const servers: Server[] = [];

const PLATFORM_ADMIN: JwtPayload = {
  sub: "u-platform",
  username: "chenyx",
  role: "admin",
  tenantId: DEFAULT_TENANT_ID,
};
const ORG_ADMIN: JwtPayload = {
  sub: "u-org",
  username: "wain_admin",
  role: "admin",
  tenantId: "wain",
};
const ORG_USER: JwtPayload = {
  sub: "u-user",
  username: "wain_user",
  role: "user",
  tenantId: "wain",
};

function makeRig() {
  let caller: JwtPayload | undefined;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = caller;
    next();
  });
  app.use("/api", enforcePlatformWritePolicy);
  app.all(/^\/api\/.*/, (req, res) => {
    res.json({ ok: true, method: req.method, path: req.path });
  });
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bind failed");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    setCaller(user: JwtPayload | undefined) {
      caller = user;
    },
    request(method: string, path: string, body?: unknown) {
      return fetch(`${baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
  };
}

afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
});

describe("平台管理员统一权限", () => {
  it("所有万神殿管理员都按完整权限平台管理员处理", () => {
    expect(isSuperAdmin(PLATFORM_ADMIN)).toBe(true);
    expect(isSuperAdmin({ ...PLATFORM_ADMIN, username: "any-platform-admin" })).toBe(true);
    expect(isSuperAdmin({ ...ORG_ADMIN, username: "admin" })).toBe(false);
    expect(isSuperAdmin(ORG_USER)).toBe(false);
    expect(isSuperAdmin(undefined)).toBe(false);
  });

  it("旧 capability 配置不再限制平台管理员", () => {
    const withoutCapabilities = { ...PLATFORM_ADMIN, platformCapabilities: [] };
    expect(hasPlatformCapability(withoutCapabilities, "tenant.manage")).toBe(true);
    expect(hasPlatformCapability(withoutCapabilities, "finance.read")).toBe(true);
    expect(getEffectivePlatformCapabilities(withoutCapabilities)).toContain("skill.platform.manage");
    expect(getEffectivePlatformCapabilities(withoutCapabilities)).toContain("runtime.operate");
    expect(getEffectivePlatformCapabilities(ORG_ADMIN)).toEqual([]);
  });

  it("原分层策略不再拦截平台写入、敏感读取或高风险操作", async () => {
    const rig = makeRig();
    rig.setCaller({ ...PLATFORM_ADMIN, platformCapabilities: [] });

    expect((await rig.request("PUT", "/api/admin/models", {})).status).toBe(200);
    expect((await rig.request("DELETE", "/api/tenants/wain", {})).status).toBe(200);
    expect((await rig.request("DELETE", "/api/auth/login-logs")).status).toBe(200);
    expect((await rig.request("GET", "/api/admin/qa/sessions/s1/messages")).status).toBe(200);
    expect((await rig.request("POST", "/api/admin/billing/accounts/wain/adjust", {})).status).toBe(200);
    expect((await rig.request("PATCH", "/api/admin/runtime-operations/scheduler/runtime-config", {})).status).toBe(200);
  });

  it("兼容守门函数允许任意平台管理员，拒绝组织管理员", async () => {
    let caller: JwtPayload | undefined;
    const app = express();
    app.use((req, _res, next) => {
      req.user = caller;
      next();
    });
    app.delete("/legacy-guard", requireSuperAdmin, (_req, res) => res.json({ ok: true }));
    app.post(
      "/capability-guard",
      requirePlatformCapability("runtime.operate"),
      (_req, res) => res.json({ ok: true }),
    );
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bind failed");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    caller = PLATFORM_ADMIN;
    expect((await fetch(`${baseUrl}/legacy-guard`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${baseUrl}/capability-guard`, { method: "POST" })).status).toBe(200);

    caller = ORG_ADMIN;
    const denied = await fetch(`${baseUrl}/legacy-guard`, { method: "DELETE" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "PLATFORM_ADMIN_REQUIRED" });
  });
});
