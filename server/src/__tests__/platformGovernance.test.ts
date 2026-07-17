import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { JwtPayload } from "../auth/types.js";
import { DEFAULT_TENANT_ID } from "../data/tenants/types.js";
import {
  enforcePlatformWritePolicy,
  getSuperAdminUsernames,
  isSuperAdmin,
  requireSuperAdmin,
} from "../auth/platformGovernance.js";

/**
 * 平台管理员分层治理测试（2026-07-18）。
 * 用探针 app 验证 enforcePlatformWritePolicy 的放行/拦截矩阵：
 * 到达探针 = 放行（200），被策略拦截 = 403 PLATFORM_READ_ONLY。
 */

const servers: Server[] = [];

const SUPER: JwtPayload = {
  sub: "u-super",
  username: "admin",
  role: "admin",
  tenantId: DEFAULT_TENANT_ID,
};
const STAFF: JwtPayload = {
  sub: "u-staff",
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
  // 探针：任何到达的请求返回 200
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
    async request(method: string, path: string, body?: unknown) {
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
  delete process.env.SUPER_ADMIN_USERNAMES;
});

describe("isSuperAdmin", () => {
  it("only platform-tenant admin with allowlisted username qualifies", () => {
    expect(isSuperAdmin(SUPER)).toBe(true);
    expect(isSuperAdmin(STAFF)).toBe(false);
    // 组织内 username 撞名 'admin' 不是 super（tenant 必须是 pantheon）
    expect(isSuperAdmin({ ...ORG_ADMIN, username: "admin" })).toBe(false);
    expect(isSuperAdmin(ORG_USER)).toBe(false);
    expect(isSuperAdmin(undefined)).toBe(false);
  });

  it("SUPER_ADMIN_USERNAMES env overrides the default allowlist", () => {
    process.env.SUPER_ADMIN_USERNAMES = "admin, ops2";
    expect(getSuperAdminUsernames()).toEqual(["admin", "ops2"]);
    expect(isSuperAdmin({ ...STAFF, username: "ops2" })).toBe(true);
    process.env.SUPER_ADMIN_USERNAMES = "  ";
    expect(getSuperAdminUsernames()).toEqual(["admin"]);
  });
});

describe("enforcePlatformWritePolicy", () => {
  it("read-only platform admin: reads pass, writes are blocked", async () => {
    const rig = makeRig();
    rig.setCaller(STAFF);

    expect((await rig.request("GET", "/api/admin/models")).status).toBe(200);
    expect((await rig.request("GET", "/api/tenants")).status).toBe(200);
    expect((await rig.request("GET", "/api/admin/billing/ledger")).status).toBe(200);

    const put = await rig.request("PUT", "/api/admin/models", {});
    expect(put.status).toBe(403);
    expect((await put.json()).code).toBe("PLATFORM_READ_ONLY");
    expect((await rig.request("DELETE", "/api/tenants/wain", {})).status).toBe(403);
    expect((await rig.request("PATCH", "/api/tenants/wain/status", {})).status).toBe(403);
    expect((await rig.request("POST", "/api/admin/billing/accounts/wain/adjust", {})).status).toBe(403);
    expect((await rig.request("POST", "/api/admin/system/storage/delete", {})).status).toBe(403);
    expect((await rig.request("PUT", "/api/admin/tool-controls", {})).status).toBe(403);
    expect((await rig.request("POST", "/api/auth/users", {})).status).toBe(403);
    expect((await rig.request("DELETE", "/api/auth/login-logs")).status).toBe(403);
    expect((await rig.request("PUT", "/api/mcp/admin/servers/x", {})).status).toBe(403);
    expect((await rig.request("POST", "/api/org-agents", {})).status).toBe(403);
    expect((await rig.request("POST", "/api/dingtalk/sessions/c1/test", {})).status).toBe(403);
  });

  it("read-only platform admin: write allowlist (create tenant + read-shaped POSTs)", async () => {
    const rig = makeRig();
    rig.setCaller(STAFF);

    expect((await rig.request("POST", "/api/tenants", { id: "demo" })).status).toBe(200);
    expect(
      (await rig.request("POST", "/api/admin/tenant-remote-hands/pool1/health", {})).status,
    ).toBe(200);
    expect(
      (await rig.request("POST", "/api/admin/runtime-operations/acs/network-policy/probe", {}))
        .status,
    ).toBe(200);
    expect(
      (await rig.request("POST", "/api/mcp/admin/users/someone/diagnose", {})).status,
    ).toBe(200);
  });

  it("read-only platform admin: content-level reads are super-only", async () => {
    const rig = makeRig();
    rig.setCaller(STAFF);

    expect((await rig.request("GET", "/api/admin/qa/sessions")).status).toBe(200);
    expect((await rig.request("GET", "/api/admin/qa/sessions/s1/messages")).status).toBe(403);
    expect((await rig.request("GET", "/api/admin/sessions/s1")).status).toBe(200);
    expect(
      (await rig.request("GET", "/api/admin/runtime/trace/runs/r1/events")).status,
    ).toBe(403);
    expect((await rig.request("GET", "/api/admin/runtime/trace/recent-runs")).status).toBe(200);
  });

  it("read-only platform admin: self-service writes on own account", async () => {
    const rig = makeRig();
    rig.setCaller(STAFF);

    expect(
      (await rig.request("POST", `/api/auth/users/${STAFF.sub}/avatar`, {})).status,
    ).toBe(200);
    expect(
      (await rig.request("PATCH", `/api/auth/users/${STAFF.sub}`, { password: "x", realName: "育新" }))
        .status,
    ).toBe(200);
    // 危险字段自改被拒
    expect(
      (await rig.request("PATCH", `/api/auth/users/${STAFF.sub}`, { role: "admin" })).status,
    ).toBe(403);
    expect(
      (await rig.request("PATCH", `/api/auth/users/${STAFF.sub}`, { tenantId: "wain" })).status,
    ).toBe(403);
    // 他人账号一律拒
    expect(
      (await rig.request("PATCH", "/api/auth/users/u-other", { password: "x" })).status,
    ).toBe(403);
    expect(
      (await rig.request("POST", "/api/auth/users/u-other/avatar", {})).status,
    ).toBe(403);
  });

  it("read-only platform admin: skills governance covers admin shapes, spares own custom skills", async () => {
    const rig = makeRig();
    rig.setCaller(STAFF);

    expect((await rig.request("PUT", "/api/skills/pool/s1/document", {})).status).toBe(403);
    expect((await rig.request("PATCH", "/api/skills/pool/visibility", {})).status).toBe(403);
    expect((await rig.request("POST", "/api/skills/sync", {})).status).toBe(403);
    expect(
      (await rig.request("PUT", "/api/skills/tenants/wain/pool/selections", {})).status,
    ).toBe(403);
    expect(
      (await rig.request("PUT", "/api/skills/users/someone/selections", {})).status,
    ).toBe(403);
    expect(
      (await rig.request("PUT", "/api/skills/custom/other/skill1/document", {})).status,
    ).toBe(403);
    expect((await rig.request("POST", "/api/skills/custom/skill1/promote", {})).status).toBe(403);
    // 自己的自建技能（三段以下形态）不属治理路径
    expect((await rig.request("PUT", "/api/skills/custom/skill1", {})).status).toBe(200);
    expect((await rig.request("GET", "/api/skills/pool")).status).toBe(200);
  });

  it("read-only platform admin: non-governed paths untouched", async () => {
    const rig = makeRig();
    rig.setCaller(STAFF);

    expect((await rig.request("POST", "/api/sessions", {})).status).toBe(200);
    expect((await rig.request("POST", "/api/upload", {})).status).toBe(200);
    expect((await rig.request("PUT", "/api/mcp/user/selections", {})).status).toBe(200);
  });

  it("super admin passes everything", async () => {
    const rig = makeRig();
    rig.setCaller(SUPER);

    expect((await rig.request("PUT", "/api/admin/models", {})).status).toBe(200);
    expect((await rig.request("DELETE", "/api/tenants/wain", {})).status).toBe(200);
    expect((await rig.request("DELETE", "/api/auth/login-logs")).status).toBe(200);
    expect((await rig.request("GET", "/api/admin/qa/sessions/s1/messages")).status).toBe(200);
    expect(
      (await rig.request("GET", "/api/admin/runtime/trace/runs/r1/events")).status,
    ).toBe(200);
  });

  it("org admins and users are not affected by this policy", async () => {
    const rig = makeRig();
    rig.setCaller(ORG_ADMIN);
    // 端点自身的租户 scope/requirePlatformAdmin 继续负责组织侧防御
    expect((await rig.request("PUT", "/api/admin/models", {})).status).toBe(200);
    expect((await rig.request("POST", "/api/auth/users", {})).status).toBe(200);

    rig.setCaller(ORG_USER);
    expect((await rig.request("POST", "/api/sessions", {})).status).toBe(200);

    rig.setCaller(undefined);
    expect((await rig.request("PUT", "/api/admin/models", {})).status).toBe(200);
  });
});

describe("requireSuperAdmin", () => {
  it("rejects everyone but super admin", async () => {
    let caller: JwtPayload | undefined;
    const app = express();
    app.use((req, _res, next) => {
      req.user = caller;
      next();
    });
    app.delete("/guarded", requireSuperAdmin, (_req, res) => {
      res.json({ ok: true });
    });
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bind failed");
    const url = `http://127.0.0.1:${address.port}/guarded`;

    caller = STAFF;
    let res = await fetch(url, { method: "DELETE" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("SUPER_ADMIN_REQUIRED");

    caller = ORG_ADMIN;
    res = await fetch(url, { method: "DELETE" });
    expect(res.status).toBe(403);

    caller = SUPER;
    res = await fetch(url, { method: "DELETE" });
    expect(res.status).toBe(200);
  });
});
