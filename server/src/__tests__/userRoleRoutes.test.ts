import express from "express";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createUserRoleRouter } from "../routes/userRole.js";
import { UserStore } from "../data/users/store.js";
import type { UserInfo } from "../data/users/types.js";

const LIBRARY = {
  version: 2,
  updatedAt: "2026-07-05",
  roles: [
    { id: "boss", name: "老板/总经理", sort: 1, roleWelcomeMessage: "老板欢迎语" },
    { id: "sales", name: "销售", sort: 2, roleWelcomeMessage: { default: "销售默认欢迎语", export: "外贸欢迎语" } },
  ],
  scenarios: [
    {
      id: "boss-competitor-daily",
      title: "竞品动态晨报",
      role: "boss",
      industries: ["all"],
      mode: "recurring",
      pitch: "每天一条消息看完同行动态",
      story: "你告诉 AI 盯哪几家 → 它每天检索 → 每早推简报",
      promptTemplate: "盯：{{targets}}",
      slots: [{ key: "targets", label: "对象", example: "同行A" }],
      requires: ["web", "dingtalk"],
      recommendCron: true,
      signalAdaptation: { dailyEmptyStreakToWeekly: 3, userNoOpenStreakToPause: 5, emptyContentFallback: "本周行业热点摘要" },
      pushSlot: { channel: "ding_work_notification", target: "self", humanReviewRequired: false },
      enabled: true,
    },
  ],
};

interface Rig {
  user: UserInfo;
  userStore: UserStore;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

async function startRig(options: { position?: string; activeRoleId?: string } = {}): Promise<Rig> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "user-role-routes-"));
  const dataPath = join(tmpRoot, "scenario-library.json");
  await writeFile(dataPath, JSON.stringify(LIBRARY), "utf-8");
  const userStore = new UserStore(join(tmpRoot, "users.json"));
  const user = await userStore.create({
    username: "alice",
    password: "password123",
    role: "user",
    createdBy: "system",
    tenantId: "kaiyan",
    position: options.position,
  });
  if (options.activeRoleId) {
    await userStore.updatePreferences(user.id, { activeRoleId: options.activeRoleId });
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      sub: user.id,
      username: user.username,
      role: user.role,
      tenantId: user.tenantId,
    };
    next();
  });
  app.use("/api/user", createUserRoleRouter({ userStore, dataPath }));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";

  return {
    user,
    userStore,
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

describe("user role routes", () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await startRig();
  });

  afterEach(async () => {
    await rig.close();
  });

  it("returns available roles and defaults to the first role when position is empty", async () => {
    const res = await rig.request("/api/user/available-roles");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      availableRoleIds: ["boss", "sales"],
      activeRoleId: "boss",
    });
  });

  it("defaults active role from user position before falling back to first role", async () => {
    await rig.close();
    rig = await startRig({ position: "销售经理" });
    const res = await rig.request("/api/user/available-roles");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      availableRoleIds: ["boss", "sales"],
      activeRoleId: "sales",
    });
  });

  it("keeps explicit active role preference above user position matching", async () => {
    await rig.close();
    rig = await startRig({ position: "销售经理", activeRoleId: "boss" });
    const res = await rig.request("/api/user/available-roles");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      availableRoleIds: ["boss", "sales"],
      activeRoleId: "boss",
    });
  });

  it("switches active role and persists user preference", async () => {
    const res = await rig.request("/api/user/switch-role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roleId: "sales" }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      activeRoleId: "sales",
      welcomeMessage: "销售默认欢迎语",
    });
    expect(rig.userStore.findById(rig.user.id)?.preferences?.activeRoleId).toBe("sales");
  });

  it("rejects unavailable roles", async () => {
    const res = await rig.request("/api/user/switch-role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roleId: "unknown" }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "role_not_available" });
  });
});
