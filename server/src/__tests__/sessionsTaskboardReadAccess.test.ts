import express from "express";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionsRouter, type SessionsRouterOptions } from "../routes/sessions.js";
import { getTranscriptPath } from "../data/transcripts/store.js";
import { writeSessionMeta } from "../data/transcripts/meta.js";
import { resolveUserCwd, type WorkspaceUser } from "../workspace/resolver.js";

const OWNER = { id: "board-owner", username: "owner", role: "user", tenantId: "tenant-1" } satisfies WorkspaceUser;
const COLLABORATOR = { id: "collaborator", username: "bob", role: "user", tenantId: "tenant-1" } satisfies WorkspaceUser;

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startServer(
  agentCwd: string,
  canReadTaskboardSession: NonNullable<SessionsRouterOptions["canReadTaskboardSession"]>,
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use((req, _res, next) => {
    req.user = {
      sub: COLLABORATOR.id,
      username: COLLABORATOR.username,
      role: COLLABORATOR.role,
      tenantId: COLLABORATOR.tenantId,
    };
    next();
  });
  app.use("/api", createSessionsRouter({ agentCwd, canReadTaskboardSession }));
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe("TaskBoard execution session 只读访问", () => {
  let agentCwd = "";

  beforeEach(async () => {
    agentCwd = await mkdtemp(join(tmpdir(), "taskboard-session-read-"));
  });

  afterEach(async () => {
    await rm(agentCwd, { recursive: true, force: true });
  });

  async function writeOwnerSession(sessionSource?: "taskboard_execution", deletedAt?: string): Promise<string> {
    const sessionId = randomUUID();
    const ownerCwd = resolveUserCwd(agentCwd, OWNER);
    const transcriptPath = getTranscriptPath(ownerCwd, sessionId, {
      tenantId: OWNER.tenantId,
      userId: OWNER.id,
    });
    await writeSessionMeta(transcriptPath, {
      userId: OWNER.id,
      username: OWNER.username,
      tenantId: OWNER.tenantId,
      channel: "web",
      createdAt: new Date().toISOString(),
      cwd: ownerCwd,
      runtimeStatus: "running",
      ...(sessionSource ? { sessionSource } : {}),
      ...(deletedAt ? { deletedAt } : {}),
    });
    return sessionId;
  }

  it("任务授权通过时返回 owner 的实际执行会话", async () => {
    const sessionId = await writeOwnerSession("taskboard_execution");
    const canReadTaskboardSession = vi.fn(async () => true);
    const { server, baseUrl } = await startServer(agentCwd, canReadTaskboardSession);
    try {
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}?silent=1`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        sessionId,
        accessMode: "read_only",
        owner: { userId: OWNER.id, username: OWNER.username },
      });
      expect(canReadTaskboardSession).toHaveBeenCalledWith({
        userId: COLLABORATOR.id,
        username: COLLABORATOR.username,
        role: COLLABORATOR.role,
        tenantId: COLLABORATOR.tenantId,
      }, sessionId);
    } finally {
      await stopServer(server);
    }
  });

  it("协作人不能通过 includeDeleted 读取 owner 已删除的执行会话", async () => {
    const sessionId = await writeOwnerSession("taskboard_execution", new Date().toISOString());
    const canReadTaskboardSession = vi.fn(async () => true);
    const { server, baseUrl } = await startServer(agentCwd, canReadTaskboardSession);
    try {
      expect((await fetch(`${baseUrl}/api/sessions/${sessionId}?silent=1&includeDeleted=1`)).status).toBe(403);
      expect(canReadTaskboardSession).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  it("任务授权拒绝时保持 403", async () => {
    const sessionId = await writeOwnerSession("taskboard_execution");
    const { server, baseUrl } = await startServer(agentCwd, async () => false);
    try {
      expect((await fetch(`${baseUrl}/api/sessions/${sessionId}?silent=1`)).status).toBe(403);
    } finally {
      await stopServer(server);
    }
  });

  it("普通外部会话不进入 TaskBoard 授权旁路", async () => {
    const sessionId = await writeOwnerSession();
    const canReadTaskboardSession = vi.fn(async () => true);
    const { server, baseUrl } = await startServer(agentCwd, canReadTaskboardSession);
    try {
      expect((await fetch(`${baseUrl}/api/sessions/${sessionId}?silent=1`)).status).toBe(403);
      expect(canReadTaskboardSession).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });
});
