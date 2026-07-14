/**
 * auth middleware 公开路径放行测试
 *
 * 背景：自助注册（/api/signup/*）必须免登录可达；这里用完整 express app
 * （真实 createAuthMiddleware 挂载）验证放行与鉴权边界，防止后续改
 * PUBLIC_ROUTES 时把注册链路误伤。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";

import { createAuthMiddleware } from "../auth/middleware.js";

const JWT_SECRET = "test-secret-test-secret-test-secret";

describe("auth middleware public routes", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createAuthMiddleware(JWT_SECRET));
    // 模拟公开与受保护端点
    app.get("/api/signup/status", (_req, res) => res.json({ ok: true }));
    app.post("/api/signup/send-code", (_req, res) => res.json({ ok: true }));
    app.post("/api/signup/register", (_req, res) => res.json({ ok: true }));
    app.post("/api/auth/sms/send-code", (_req, res) => res.json({ ok: true }));
    app.post("/api/auth/sms/login", (_req, res) => res.json({ ok: true }));
    app.get("/api/healthz", (_req, res) => res.send("ok"));
    app.get("/api/healthz/drain", (_req, res) => res.json({ idle: true }));
    app.get("/api/share/sessions/test-token", (_req, res) => res.json({ ok: true }));
    app.get("/api/share/sessions/test-token/file", (_req, res) => res.json({ ok: true }));
    app.get("/api/mcp/oauth/callback", (_req, res) => res.json({ ok: true }));
    app.get("/api/mcp/oauth/client-metadata", (_req, res) => res.json({ ok: true }));
    app.get("/api/protected", (_req, res) => res.json({ ok: true }));

    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address();
    baseUrl =
      typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("signup 三端点免登录可达", async () => {
    expect((await fetch(`${baseUrl}/api/signup/status`)).status).toBe(200);
    expect(
      (await fetch(`${baseUrl}/api/signup/send-code`, { method: "POST" }))
        .status,
    ).toBe(200);
    expect(
      (await fetch(`${baseUrl}/api/signup/register`, { method: "POST" }))
        .status,
    ).toBe(200);
  });

  it("短信登录端点免登录可达", async () => {
    expect(
      (await fetch(`${baseUrl}/api/auth/sms/send-code`, { method: "POST" }))
        .status,
    ).toBe(200);
    expect(
      (await fetch(`${baseUrl}/api/auth/sms/login`, { method: "POST" }))
        .status,
    ).toBe(200);
  });

  it("healthz 与 drain 探针免登录可达", async () => {
    expect((await fetch(`${baseUrl}/api/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/healthz/drain`)).status).toBe(200);
  });

  it("会话分享公开读取端点免登录可达", async () => {
    expect((await fetch(`${baseUrl}/api/share/sessions/test-token`)).status).toBe(200);
  });

  it("会话分享文件端点免登录可达", async () => {
    expect((await fetch(`${baseUrl}/api/share/sessions/test-token/file?path=assets%2Fdemo.html`)).status).toBe(200);
  });

  it("MCP OAuth 回调与 client metadata 免登录可达", async () => {
    expect((await fetch(`${baseUrl}/api/mcp/oauth/callback?state=test`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/mcp/oauth/client-metadata`)).status).toBe(200);
  });

  it("非公开路径无 token 仍 401（放行未扩大化）", async () => {
    expect((await fetch(`${baseUrl}/api/protected`)).status).toBe(401);
  });
});
