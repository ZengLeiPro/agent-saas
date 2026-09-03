/**
 * Cron API 路由覆盖测试（routes/cron.ts）
 *
 * 采用 feedbackRoutes.test.ts 标准模式：真 express + app.listen(0) + 真 fetch，
 * 注入一个用内存 deps 装配的真实 CronService（不 mock 被测 handler / service 逻辑），
 * runsDir 用临时目录，只补现有测试未覆盖的路由分支：
 *   - owner-only 权限边界（403）
 *   - 系统任务（systemKind）门禁：普通用户 404 隐藏 / patch·delete 403
 *   - Zod 校验 400、cron 表达式 400、钉钉 notify 交叉校验 400
 *   - 404 not found、runs / run details 分支（409 无 transcript）
 *   - /validate、/status
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createCronRouter } from "../routes/cron.js";
import { CronService } from "../cron/service.js";
import type { CronServiceDeps } from "../cron/service.js";
import type { CronJob, CronRunLogEntry } from "../cron/types.js";
import { appendRunLog } from "../cron/run-log.js";
import { PLATFORM_TENANT_ID } from "../data/tenants/types.js";
import type { JwtPayload } from "../auth/types.js";

/** 普通用户（组织 kaiyan） */
const OWNER: JwtPayload = {
  sub: "u-owner",
  username: "owner",
  role: "user",
  tenantId: "kaiyan",
};
/** 同租户另一用户（用于 owner-only 403 边界） */
const OTHER: JwtPayload = {
  sub: "u-other",
  username: "other",
  role: "user",
  tenantId: "kaiyan",
};
/** 平台管理员（pantheon 租户 admin）——可见系统任务 */
const PLATFORM_ADMIN: JwtPayload = {
  sub: "root",
  username: "root",
  role: "admin",
  tenantId: PLATFORM_TENANT_ID,
};

/** 用内存 deps 装配一个真实 CronService；预置 jobs 直接作为初始加载集。 */
function makeService(
  runsDir: string,
  initialJobs: CronJob[],
  overrides: Partial<CronServiceDeps> = {},
): CronService {
  // 用可变引用持有当前 jobs，saveJobs 回写，模拟持久化
  let stored = initialJobs;
  const deps: CronServiceDeps = {
    nowMs: () => 1_700_000_000_000,
    loadJobs: async () => stored.map((j) => ({ ...j, state: { ...j.state } })),
    saveJobs: async (jobs) => {
      stored = jobs;
    },
    // executeJob 不会在这些路由用例里真正跑（runNow 是后台异步，我们只断言 HTTP 立即响应）
    executeJob: async () => ({ status: "ok" as const }),
    // runNow 是后台异步，其 appendRunLog 可能在测试 afterEach 清理临时目录后才触发；
    // 吞掉写入错误避免 teardown 后的无害异步噪声（不影响任何 HTTP 断言）
    appendRunLog: async (entry) => {
      await appendRunLog(entry, { runsDir }).catch(() => {});
    },
    ...overrides,
  };
  return new CronService(deps);
}

/** 一个普通 agentTurn cron 任务模板 */
function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: overrides.id ?? "job-1",
    name: overrides.name ?? "每日巡检",
    enabled: overrides.enabled ?? true,
    schedule: overrides.schedule ?? {
      kind: "cron",
      expr: "0 9 * * *",
      tz: "Asia/Shanghai",
    },
    payload: overrides.payload ?? { kind: "agentTurn", message: "巡检一下" },
    owner: overrides.owner ?? OWNER.sub,
    ownerName: overrides.ownerName ?? OWNER.username,
    createdAtMs: 1,
    updatedAtMs: 1,
    state: overrides.state ?? {},
    ...(overrides.systemKind ? { systemKind: overrides.systemKind } : {}),
  };
}

async function startServer(
  service: CronService,
  runsDir: string,
  user: JwtPayload | undefined,
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) (req as unknown as { user: JwtPayload }).user = user;
    next();
  });
  app.use("/api/cron", createCronRouter(service, runsDir));
  return new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server: s, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(s: Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

describe("cron routes coverage", () => {
  let runsDir: string;
  const servers: Server[] = [];

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "cron-routes-test-"));
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) await stopServer(s);
    await rm(runsDir, { recursive: true, force: true });
  });

  it("GET /status 冷读时先加载最新任务快照", async () => {
    const service = makeService(runsDir, [
      makeJob({ id: "job-1", name: "任务一", owner: OWNER.sub }),
      makeJob({
        id: "job-2",
        name: "任务二",
        owner: OWNER.sub,
        enabled: false,
      }),
    ]);
    const { server, baseUrl } = await startServer(service, runsDir, OWNER);
    servers.push(server);

    const statusRes = await fetch(`${baseUrl}/api/cron/status`);
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toMatchObject({
      jobCount: 2,
      enabledJobCount: 1,
    });
  });

  it("GET /status 返回服务状态；GET /jobs 只列自己的任务并隐藏他人系统任务", async () => {
    const service = makeService(runsDir, [
      makeJob({ id: "job-1", name: "我的任务", owner: OWNER.sub }),
      makeJob({ id: "job-2", name: "他人任务", owner: OTHER.sub }),
      makeJob({
        id: "sys-1",
        name: "记忆轮询",
        owner: OWNER.sub,
        systemKind: "memory_poll",
      }),
    ]);
    const { server, baseUrl } = await startServer(service, runsDir, OWNER);
    servers.push(server);

    // owner 列表：自己的普通任务可见；他人任务过滤；自己的系统任务对普通用户隐藏
    // （先查列表触发 ensureLoaded，getStatus 本身不做懒加载）
    const jobsRes = await fetch(`${baseUrl}/api/cron/jobs`);
    expect(jobsRes.status).toBe(200);
    const { jobs } = (await jobsRes.json()) as { jobs: CronJob[] };
    const ids = jobs.map((j) => j.id).sort();
    expect(ids).toEqual(["job-1"]);

    const statusRes = await fetch(`${baseUrl}/api/cron/status`);
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as {
      enabled: boolean;
      jobCount: number;
    };
    expect(status.enabled).toBe(true);
    expect(status.jobCount).toBe(3);
  });

  it("平台 admin 能在列表看到系统任务", async () => {
    const service = makeService(runsDir, [
      makeJob({
        id: "sys-1",
        name: "记忆轮询",
        owner: "root",
        systemKind: "memory_poll",
      }),
    ]);
    const { server, baseUrl } = await startServer(
      service,
      runsDir,
      PLATFORM_ADMIN,
    );
    servers.push(server);

    const jobsRes = await fetch(`${baseUrl}/api/cron/jobs`);
    expect(jobsRes.status).toBe(200);
    const { jobs } = (await jobsRes.json()) as { jobs: CronJob[] };
    expect(jobs.map((j) => j.id)).toEqual(["sys-1"]);
  });

  it("GET /jobs/:id：404 不存在 / 403 非本人 / 系统任务对普通用户 404 隐藏 / 200 本人", async () => {
    const service = makeService(runsDir, [
      makeJob({ id: "job-1", owner: OWNER.sub }),
      makeJob({ id: "job-2", owner: OTHER.sub }),
      makeJob({ id: "sys-1", owner: OWNER.sub, systemKind: "memory_poll" }),
    ]);
    const { server, baseUrl } = await startServer(service, runsDir, OWNER);
    servers.push(server);

    expect((await fetch(`${baseUrl}/api/cron/jobs/nope`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/cron/jobs/job-2`)).status).toBe(403);
    // 系统任务对普通用户：404（隐藏而非 403，避免暴露存在性）
    expect((await fetch(`${baseUrl}/api/cron/jobs/sys-1`)).status).toBe(404);
    const okRes = await fetch(`${baseUrl}/api/cron/jobs/job-1`);
    expect(okRes.status).toBe(200);
    expect(((await okRes.json()) as CronJob).id).toBe("job-1");
  });

  it("POST /jobs：201 创建（带 owner 上下文）/ 400 Zod 校验 / 400 非法 cron 表达式", async () => {
    const service = makeService(runsDir, []);
    const { server, baseUrl } = await startServer(service, runsDir, OWNER);
    servers.push(server);

    // 校验失败：缺 name
    const bad = await fetch(`${baseUrl}/api/cron/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schedule: { kind: "cron", expr: "0 9 * * *" },
        payload: { kind: "agentTurn", message: "x" },
      }),
    });
    expect(bad.status).toBe(400);

    // 非法 cron 表达式
    const badCron = await fetch(`${baseUrl}/api/cron/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "t",
        schedule: { kind: "cron", expr: "not a cron" },
        payload: { kind: "agentTurn", message: "x" },
      }),
    });
    expect(badCron.status).toBe(400);
    expect(((await badCron.json()) as { error: string }).error).toContain(
      "Invalid cron expression",
    );

    // 成功创建
    const ok = await fetch(`${baseUrl}/api/cron/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "新任务",
        schedule: { kind: "every", everyMs: 60000 },
        payload: { kind: "agentTurn", message: "干活" },
      }),
    });
    expect(ok.status).toBe(201);
    const created = (await ok.json()) as CronJob;
    expect(created.name).toBe("新任务");
    expect(created.owner).toBe(OWNER.sub);
    expect(created.ownerName).toBe(OWNER.username);
  });

  it("POST /jobs：钉钉 notify 交叉字段校验 400（session 模式缺 conversationId）", async () => {
    const service = makeService(runsDir, []);
    const { server, baseUrl } = await startServer(service, runsDir, OWNER);
    servers.push(server);

    const res = await fetch(`${baseUrl}/api/cron/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "带通知",
        schedule: { kind: "every", everyMs: 60000 },
        payload: { kind: "agentTurn", message: "干活" },
        notify: {
          enabled: true,
          channel: "dingtalk",
          dingtalk: { mode: "session" },
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "conversationId",
    );
  });

  it("PATCH /jobs/:id：404 / 403 非本人 / 系统任务 403 / 400 非法 cron / 200 启停审计", async () => {
    const service = makeService(runsDir, [
      makeJob({ id: "job-1", owner: OWNER.sub, enabled: true }),
      makeJob({ id: "job-2", owner: OTHER.sub }),
      makeJob({ id: "sys-1", owner: OWNER.sub, systemKind: "memory_poll" }),
    ]);
    const { server, baseUrl } = await startServer(service, runsDir, OWNER);
    servers.push(server);

    const patch = (id: string, body: unknown) =>
      fetch(`${baseUrl}/api/cron/jobs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await patch("nope", { enabled: false })).status).toBe(404);
    expect((await patch("job-2", { enabled: false })).status).toBe(403);
    // 系统任务禁止改
    const sysRes = await patch("sys-1", { enabled: false });
    expect(sysRes.status).toBe(403);
    expect(((await sysRes.json()) as { error: string }).error).toContain(
      "系统任务",
    );
    // 非法 cron 表达式
    expect(
      (await patch("job-1", { schedule: { kind: "cron", expr: "bad bad" } }))
        .status,
    ).toBe(400);

    // 成功：切换启停（单字段 → toggle 审计路径）
    const toggle = await patch("job-1", { enabled: false });
    expect(toggle.status).toBe(200);
    expect(((await toggle.json()) as CronJob).enabled).toBe(false);

    // 成功：常规编辑（多字段 → updated 审计路径）
    const edit = await patch("job-1", { name: "改名", description: "desc" });
    expect(edit.status).toBe(200);
    expect(((await edit.json()) as CronJob).name).toBe("改名");
  });

  it("DELETE /jobs/:id：404 / 403 非本人 / 系统任务 403 / 200 删除", async () => {
    const service = makeService(runsDir, [
      makeJob({ id: "job-1", owner: OWNER.sub }),
      makeJob({ id: "job-2", owner: OTHER.sub }),
      makeJob({ id: "sys-1", owner: OWNER.sub, systemKind: "memory_poll" }),
    ]);
    const { server, baseUrl } = await startServer(service, runsDir, OWNER);
    servers.push(server);

    const del = (id: string) =>
      fetch(`${baseUrl}/api/cron/jobs/${id}`, { method: "DELETE" });
    expect((await del("nope")).status).toBe(404);
    expect((await del("job-2")).status).toBe(403);
    const sysRes = await del("sys-1");
    expect(sysRes.status).toBe(403);
    expect(((await sysRes.json()) as { error: string }).error).toContain(
      "系统任务",
    );

    const ok = await del("job-1");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);
    // 二次删除 → 404（确认真删了）
    expect((await del("job-1")).status).toBe(404);
  });

  it("POST /jobs/:id/run：404 / 403 非本人 / 200 触发", async () => {
    const service = makeService(runsDir, [
      makeJob({ id: "job-1", owner: OWNER.sub }),
      makeJob({ id: "job-2", owner: OTHER.sub }),
    ]);
    const { server, baseUrl } = await startServer(service, runsDir, OWNER);
    servers.push(server);

    const run = (id: string) =>
      fetch(`${baseUrl}/api/cron/jobs/${id}/run`, { method: "POST" });
    expect((await run("nope")).status).toBe(404);
    expect((await run("job-2")).status).toBe(403);
    const ok = await run("job-1");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("GET /jobs/:id/runs：404 / 403 / 200 返回运行日志（hasTranscript 由 sessionId 推断，transcriptPath 脱敏）", async () => {
    const service = makeService(runsDir, [
      makeJob({ id: "job-1", owner: OWNER.sub }),
      makeJob({ id: "job-2", owner: OTHER.sub }),
    ]);
    // 预置一条运行日志（含 sessionId 与 transcriptPath）
    const entry: CronRunLogEntry = {
      runId: "run-1",
      startedAtMs: 100,
      endedAtMs: 200,
      jobId: "job-1",
      jobName: "每日巡检",
      status: "ok",
      sessionId: "sess-1",
      transcriptPath: "/secret/path.jsonl",
      durationMs: 100,
    };
    await appendRunLog(entry, { runsDir });

    const { server, baseUrl } = await startServer(service, runsDir, OWNER);
    servers.push(server);

    expect((await fetch(`${baseUrl}/api/cron/jobs/nope/runs`)).status).toBe(
      404,
    );
    expect((await fetch(`${baseUrl}/api/cron/jobs/job-2/runs`)).status).toBe(
      403,
    );

    const res = await fetch(`${baseUrl}/api/cron/jobs/job-1/runs`);
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(entries).toHaveLength(1);
    expect(entries[0].runId).toBe("run-1");
    expect(entries[0].hasTranscript).toBe(true);
    // transcriptPath 不应泄漏到列表接口
    expect(entries[0].transcriptPath).toBeUndefined();
  });

  it("手动 request id 幂等并通过 retry API 返回明确谱系", async () => {
    const service = makeService(runsDir, [
      makeJob({ id: "job-1", owner: OWNER.sub }),
    ]);
    await appendRunLog(
      {
        runId: "source-run",
        startedAtMs: 100,
        endedAtMs: 200,
        jobId: "job-1",
        jobName: "每日巡检",
        status: "error",
        durationMs: 100,
        attempt: 1,
        trigger: "manual",
      },
      { runsDir },
    );
    const { server, baseUrl } = await startServer(service, runsDir, OWNER);
    servers.push(server);

    const first = (await (
      await fetch(`${baseUrl}/api/cron/jobs/job-1/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "manual-request-1" }),
      })
    ).json()) as { runId: string; requestId: string; deduplicated: boolean };
    const duplicate = (await (
      await fetch(`${baseUrl}/api/cron/jobs/job-1/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "manual-request-1" }),
      })
    ).json()) as { runId: string; requestId: string; deduplicated: boolean };
    expect(duplicate).toMatchObject({
      runId: first.runId,
      requestId: "manual-request-1",
      deduplicated: true,
    });

    const retryResponse = await fetch(
      `${baseUrl}/api/cron/jobs/job-1/runs/source-run/retry`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "retry-request-1" }),
      },
    );
    expect(retryResponse.status).toBe(200);
    expect(await retryResponse.json()).toMatchObject({
      ok: true,
      requestId: "retry-request-1",
      retryOf: "source-run",
      parentRunId: "source-run",
      attempt: 2,
      deduplicated: false,
    });
  });

  it("显式取消只终结关联 Runtime Run，不等价于禁用未来调度", async () => {
    const cancelRuntimeRun = vi.fn(async ({ runtimeRunId, sessionId, reason }) => ({
      runId: runtimeRunId, sessionId, status: "cancelled" as const, statusReason: reason,
    }));
    const service = makeService(runsDir, [makeJob({
      id: "job-1",
      owner: OWNER.sub,
      state: {
        runningAtMs: 1_699_999_999_000,
        runningRunId: "cron-run-1",
        runningLeaseId: "lease-1",
        executionLedger: [{
          idempotencyKey: "cron:job-1:request:req-1",
          runId: "cron-run-1",
          startedAtMs: 1_699_999_999_000,
          claimedAtMs: 1_699_999_999_000,
          runningAtMs: 1_699_999_999_000,
          status: "running",
          ownerId: "owner-1",
          leaseId: "lease-1",
          leaseVersion: 1,
          trigger: "manual",
          requestId: "req-1",
          attempt: 1,
          sessionId: "session-1",
          runtimeRunId: "runtime-run-1",
        }],
      },
    })], { cancelRuntimeRun });
    const denied = await startServer(service, runsDir, OTHER);
    servers.push(denied.server);
    expect((await fetch(`${denied.baseUrl}/api/cron/jobs/job-1/runs/cron-run-1/cancel`, { method: "POST" })).status).toBe(403);

    const owner = await startServer(service, runsDir, OWNER);
    servers.push(owner.server);
    const response = await fetch(`${owner.baseUrl}/api/cron/jobs/job-1/runs/cron-run-1/cancel`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, runId: "cron-run-1" });
    expect(cancelRuntimeRun).toHaveBeenCalledTimes(1);
    expect((await service.get("job-1"))?.enabled).toBe(true);
    expect((await service.get("job-1"))?.state.runningRunId).toBeUndefined();
  });

  it("retry API 保持 owner 权限边界", async () => {
    const service = makeService(runsDir, [
      makeJob({ id: "job-1", owner: OWNER.sub }),
    ]);
    await appendRunLog(
      {
        runId: "source-run",
        startedAtMs: 100,
        endedAtMs: 200,
        jobId: "job-1",
        jobName: "每日巡检",
        status: "error",
        durationMs: 100,
      },
      { runsDir },
    );
    const { server, baseUrl } = await startServer(service, runsDir, OTHER);
    servers.push(server);
    const response = await fetch(
      `${baseUrl}/api/cron/jobs/job-1/runs/source-run/retry`,
      { method: "POST" },
    );
    expect(response.status).toBe(403);
  });

  it("Cron 运行历史按 runId 归并重复终态，并对组织用户净化运行错误", async () => {
    const service = makeService(runsDir, [
      makeJob({
        id: "job-1",
        owner: OWNER.sub,
        state: {
          lastStatus: "error",
          lastError:
            "Error at /workspace/releases/abcdef123456/server.js\n    at run (/srv/app.js:10:2)",
        },
      }),
    ]);
    await appendRunLog(
      {
        runId: "run-dup",
        startedAtMs: 100,
        endedAtMs: 150,
        jobId: "job-1",
        jobName: "每日巡检",
        status: "error",
        error:
          "/workspace/releases/abcdef123456/server.js: failed\nstack trace",
        durationMs: 50,
      },
      { runsDir },
    );
    await appendRunLog(
      {
        runId: "run-dup",
        startedAtMs: 100,
        endedAtMs: 200,
        jobId: "job-1",
        jobName: "每日巡检",
        status: "error",
        error: "/workspace/releases/abcdef123456/server.js: final\nstack trace",
        durationMs: 100,
      },
      { runsDir },
    );

    const { server, baseUrl } = await startServer(service, runsDir, OWNER);
    servers.push(server);

    const jobs = (await (await fetch(`${baseUrl}/api/cron/jobs`)).json()) as {
      jobs: CronJob[];
    };
    expect(jobs.jobs[0]?.state.lastError).toBe("执行失败（详细错误已隐藏）");
    expect(jobs.jobs[0]?.state).toMatchObject({
      errorCode: "CRON_RUN_FAILED",
      diagnosticId: expect.stringMatching(/^diag_/),
    });

    const body = (await (
      await fetch(`${baseUrl}/api/cron/jobs/job-1/runs`)
    ).json()) as { entries: Array<Record<string, unknown>> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      runId: "run-dup",
      endedAtMs: 200,
      error: "执行失败（详细错误已隐藏）",
      errorCode: "CRON_RUN_FAILED",
      diagnosticId: expect.stringMatching(/^diag_/),
    });
    expect(JSON.stringify(body)).not.toContain("/workspace");
    expect(JSON.stringify(body)).not.toContain("abcdef123456");
    expect(JSON.stringify(body)).not.toContain("stack trace");
  });

  it("Cron 历史在同一 runId 重复超过 limit*4 时仍填满去重页并返回 hasMore", async () => {
    const service = makeService(runsDir, [
      makeJob({ id: "job-1", owner: OWNER.sub }),
    ]);
    for (const [runId, endedAtMs] of [
      ["run-old-1", 100],
      ["run-old-2", 200],
    ] as const) {
      await appendRunLog(
        {
          runId,
          startedAtMs: endedAtMs - 10,
          endedAtMs,
          jobId: "job-1",
          jobName: "巡检",
          status: "ok",
          durationMs: 10,
        },
        { runsDir },
      );
    }
    for (let i = 0; i < 10; i += 1) {
      await appendRunLog(
        {
          runId: "run-duplicate",
          startedAtMs: 300,
          endedAtMs: 301 + i,
          jobId: "job-1",
          jobName: "巡检",
          status: "error",
          durationMs: i + 1,
        },
        { runsDir },
      );
    }

    const { server, baseUrl } = await startServer(service, runsDir, OWNER);
    servers.push(server);
    const body = (await (
      await fetch(`${baseUrl}/api/cron/jobs/job-1/runs?limit=2`)
    ).json()) as {
      entries: Array<{ runId: string }>;
      hasMore: boolean;
    };

    expect(body.entries).toHaveLength(2);
    expect(body.entries.map((entry) => entry.runId)).toContain("run-duplicate");
    expect(new Set(body.entries.map((entry) => entry.runId)).size).toBe(2);
    expect(body.hasMore).toBe(true);
  });

  it("GET /jobs/:id/runs/:runId/details：404 job / 404 run / 409 无 transcript 且无法定位", async () => {
    const service = makeService(runsDir, [
      makeJob({ id: "job-1", owner: OWNER.sub }),
    ]);
    // 一条既无 transcriptPath 也无 sessionId 的运行 → 无法定位 → 409
    await appendRunLog(
      {
        runId: "run-notrans",
        startedAtMs: 100,
        endedAtMs: 200,
        jobId: "job-1",
        jobName: "每日巡检",
        status: "ok",
        durationMs: 100,
      },
      { runsDir },
    );

    const { server, baseUrl } = await startServer(service, runsDir, OWNER);
    servers.push(server);

    expect(
      (await fetch(`${baseUrl}/api/cron/jobs/nope/runs/x/details`)).status,
    ).toBe(404);
    // job 存在但 runId 不存在 → 404 Run not found
    expect(
      (await fetch(`${baseUrl}/api/cron/jobs/job-1/runs/missing/details`))
        .status,
    ).toBe(404);
    // run 存在但无 transcript 且无 sessionId → 409
    const res409 = await fetch(
      `${baseUrl}/api/cron/jobs/job-1/runs/run-notrans/details`,
    );
    expect(res409.status).toBe(409);
    expect(((await res409.json()) as { error: string }).error).toContain(
      "transcriptPath",
    );
  });

  it("POST /validate：400 缺表达式 / 200 返回校验结果", async () => {
    const service = makeService(runsDir, []);
    const { server, baseUrl } = await startServer(service, runsDir, OWNER);
    servers.push(server);

    const missing = await fetch(`${baseUrl}/api/cron/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    const valid = await fetch(`${baseUrl}/api/cron/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expr: "0 9 * * *", tz: "Asia/Shanghai" }),
    });
    expect(valid.status).toBe(200);
    expect(((await valid.json()) as { valid: boolean }).valid).toBe(true);

    const invalid = await fetch(`${baseUrl}/api/cron/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expr: "nonsense" }),
    });
    expect(invalid.status).toBe(200);
    expect(((await invalid.json()) as { valid: boolean }).valid).toBe(false);
  });

  it("auth 未启用（无 req.user）时 canAccess 放行：可读任意任务", async () => {
    const service = makeService(runsDir, [
      makeJob({ id: "job-1", owner: "someone-else" }),
    ]);
    const { server, baseUrl } = await startServer(service, runsDir, undefined);
    servers.push(server);

    // 无 user → canAccess 返回 true，即使 owner 不是当前用户也可读
    const res = await fetch(`${baseUrl}/api/cron/jobs/job-1`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as CronJob).id).toBe("job-1");
  });
});
