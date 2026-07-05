import express from "express";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createContentOpsRouter } from "../routes/contentOps.js";
import { DEFAULT_TENANT_ID } from "../data/tenants/types.js";
import type { JwtPayload } from "../auth/types.js";

interface Rig {
  setUser(user: JwtPayload): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

async function startRig(): Promise<Rig> {
  const app = express();
  app.use(express.json());
  let currentUser: JwtPayload = {
    sub: "admin-1",
    username: "platform_admin",
    role: "admin",
    tenantId: DEFAULT_TENANT_ID,
  };
  app.use((req, _res, next) => {
    req.user = currentUser;
    next();
  });
  app.use("/api/contentops", createContentOpsRouter());

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";

  return {
    setUser(user) {
      currentUser = user;
    },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("contentOps routes", () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await startRig();
  });

  afterEach(async () => {
    await rig.close();
  });

  it("previews sanitize output for platform admin", async () => {
    const res = await rig.request("/api/contentops/scenarios/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "demo",
        title: "用 Claude 看资料",
        pitch: "登录 agent-saas 后填写 prompt",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      safeToPublish: boolean;
      scenario: { title: string };
      hits: unknown[];
      blocked: unknown[];
    };
    expect(body.safeToPublish).toBe(false);
    expect(body.scenario.title).toBe("用 AI 大脑 看资料");
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.blocked.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects non-platform admin", async () => {
    rig.setUser({
      sub: "org-admin-1",
      username: "org_admin",
      role: "admin",
      tenantId: "kaiyan",
    });
    const res = await rig.request("/api/contentops/scenarios/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "干净标题" }),
    });
    expect(res.status).toBe(403);
  });
});
