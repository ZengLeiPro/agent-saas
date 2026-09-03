/**
 * CronService 生命周期与守护逻辑测试
 *
 * 与现有 cron 测试的分工（不重复已覆盖路径）：
 * - cronServiceEveryAnchor.test.ts：kind=every 固定频率无漂移、update 保留 anchor
 * - cronServicePayloadPatch.test.ts：payload/description patch 合并语义
 * - cronScheduler.test.ts：纯调度计算（computeNextRunAtMs 等）
 * - cronLeadership.test.ts：PG advisory lock 的 leadership 获取/丢失
 *
 * 本文件专测 service.ts 此前未覆盖的区域：
 * 1. watchdog（checkStaleJobs + startWatchdog/stopWatchdog）：卡死任务的
 *    强制清理因果链（状态、run log、notify、nextRun 重排、persist、事件）
 * 2. start/stop 生命周期：stop→start 循环后 enabled 复位并恢复调度
 *    （对应生产 PG leadership 失而复得后重启调度的场景）
 * 3. normalizeEverySchedule（ensureLoaded 加载时）：everyMs clamp、
 *    disabled 不回填 anchor、anchor=nextRun-everyMs 回填（含 toFiniteInt 边界）
 * 4. pTimeout 服务级硬超时：超时 reject 的错误信息落库 + onSessionId 提前捕获
 *
 * 时间全部通过注入的 nowMs 变量推进；需要 timer 触发时配合
 * vi.useFakeTimers/advanceTimersByTimeAsync，不依赖真实 sleep。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronService, type CronServiceDeps } from "../cron/service.js";
import type { CronEvent, CronJob, CronRunLogEntry } from "../cron/types.js";

interface Harness {
  service: CronService;
  clock: { now: number };
  saved: CronJob[][];
  runLogs: CronRunLogEntry[];
  notifies: Array<{
    job: CronJob;
    run: CronRunLogEntry;
    output?: string;
    error?: string;
  }>;
  events: CronEvent[];
  runtimeCancels: Array<{ runtimeRunId: string; sessionId: string; reason: string }>;
  clear: () => void;
}

function makeHarness(
  opts: {
    loadJobs?: CronServiceDeps["loadJobs"];
    executeJob?: CronServiceDeps["executeJob"];
    onSessionCreated?: CronServiceDeps["onSessionCreated"];
    defaultTimeoutSeconds?: number;
    tryAcquireRunLease?: CronServiceDeps["tryAcquireRunLease"];
    inspectRuntimeRun?: CronServiceDeps["inspectRuntimeRun"];
    cancelRuntimeRun?: CronServiceDeps["cancelRuntimeRun"];
    resolveOwnerTenantId?: CronServiceDeps["resolveOwnerTenantId"];
  } = {},
): Harness {
  const clock = { now: 1_000_000 };
  const saved: CronJob[][] = [];
  const runLogs: CronRunLogEntry[] = [];
  const notifies: Harness["notifies"] = [];
  const events: CronEvent[] = [];
  const runtimeCancels: Harness["runtimeCancels"] = [];

  const service = new CronService({
    nowMs: () => clock.now,
    loadJobs: opts.loadJobs ?? (async () => []),
    saveJobs: async (jobs) => {
      saved.push(jobs.map((j) => ({ ...j })));
    },
    tryAcquireRunLease: opts.tryAcquireRunLease,
    executeJob:
      opts.executeJob ?? (async () => ({ status: "ok", output: "done" })),
    appendRunLog: async (entry) => {
      runLogs.push(entry);
    },
    inspectRuntimeRun: opts.inspectRuntimeRun,
    cancelRuntimeRun: opts.cancelRuntimeRun ?? (async (input) => {
      runtimeCancels.push(input);
      return {
        runId: input.runtimeRunId,
        sessionId: input.sessionId,
        status: "cancelled",
        statusReason: input.reason,
      };
    }),
    notify: async (args) => {
      notifies.push(args);
    },
    onSessionCreated: opts.onSessionCreated,
    onEvent: (e) => {
      events.push(e);
    },
    defaultTimeoutSeconds: opts.defaultTimeoutSeconds,
    resolveOwnerTenantId: opts.resolveOwnerTenantId,
  });

  const clear = () => {
    saved.length = 0;
    runLogs.length = 0;
    notifies.length = 0;
    events.length = 0;
    runtimeCancels.length = 0;
  };

  return { service, clock, saved, runLogs, notifies, events, runtimeCancels, clear };
}

/** executeJob 永不 resolve，模拟卡死的任务执行。 */
const hangingExecuteJob: CronServiceDeps["executeJob"] = () =>
  new Promise(() => {});

let rawJobSeq = 0;
function rawJob(
  over: Partial<CronJob> & { schedule: CronJob["schedule"] },
): CronJob {
  rawJobSeq += 1;
  return {
    id: `raw-${rawJobSeq}`,
    name: `raw-job-${rawJobSeq}`,
    enabled: true,
    payload: { kind: "systemEvent", text: "ping" },
    createdAtMs: 0,
    updatedAtMs: 0,
    state: {},
    ...over,
  };
}

async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const statusEvents = (events: CronEvent[]) =>
  events.filter(
    (e): e is Extract<CronEvent, { type: "statusChanged" }> =>
      e.type === "statusChanged",
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("cron service watchdog", () => {
  // 通过 runNow + 永不 resolve 的 executeJob 走真实卡死路径，
  // 再直接调用私有 checkStaleJobs（不依赖 60s interval），时间由注入 nowMs 控制。
  async function arrangeStuckJob(
    h: Harness,
    create: Parameters<CronService["add"]>[0],
    context?: Parameters<CronService["add"]>[1],
  ) {
    const job = await h.service.add(create, context);
    const res = await h.service.runNow(job.id);
    expect(res).toEqual({ ran: true });
    expect((await h.service.get(job.id))?.state.runningAtMs).toBe(1_000_000);
    h.clear(); // 丢弃 add/runNow 阶段的 persist/事件，聚焦 watchdog 本身
    return job;
  }

  it("does nothing while elapsed <= deadline (jobTimeout + 180s overtime)", async () => {
    const h = makeHarness({ executeJob: hangingExecuteJob });
    // timeoutSeconds=600 → deadline = 600_000 + 180_000 = 780_000ms
    const job = await arrangeStuckJob(h, {
      name: "hung-agent",
      schedule: { kind: "every", everyMs: 86_400_000 },
      payload: { kind: "agentTurn", message: "do it", timeoutSeconds: 600 },
    });

    // elapsed 恰好等于 deadline：边界上不动作
    h.clock.now = 1_000_000 + 780_000;
    await (h.service as any).checkStaleJobs();

    const after = await h.service.get(job.id);
    expect(after?.state.runningAtMs).toBe(1_000_000);
    expect(after?.state.lastStatus).toBeUndefined();
    expect(h.runLogs).toHaveLength(0);
    expect(h.notifies).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("freezes the watchdog deadline at claim time when timeout is edited during a run", async () => {
    const h = makeHarness({ executeJob: hangingExecuteJob });
    const job = await arrangeStuckJob(h, {
      name: "timeout-edited",
      schedule: { kind: "every", everyMs: 86_400_000 },
      payload: { kind: "agentTurn", message: "do it", timeoutSeconds: 3600 },
    });

    await h.service.update(job.id, {
      payload: { kind: "agentTurn", timeoutSeconds: 1 },
    });
    h.clear();
    h.clock.now = 1_000_000 + 300_000;
    await (h.service as any).checkStaleJobs();

    const after = await h.service.get(job.id);
    expect(after?.state.runningAtMs).toBe(1_000_000);
    expect(after?.state.runningDeadlineAtMs).toBe(1_000_000 + 3_780_000);
    expect(h.runLogs).toHaveLength(0);
  });

  it("cancels the linked Runtime run before finalizing a stuck parent", async () => {
    const h = makeHarness({ executeJob: hangingExecuteJob, resolveOwnerTenantId: () => "tenant-1" });
    const job = await arrangeStuckJob(h, {
      name: "hung-agent",
      schedule: { kind: "every", everyMs: 86_400_000 },
      payload: { kind: "agentTurn", message: "do it", timeoutSeconds: 600 },
    }, { owner: "user-1" });
    const activeRunId = (await h.service.get(job.id))!.state.runningRunId!;

    h.clock.now = 1_780_001;
    await (h.service as any).checkStaleJobs();

    const after = await h.service.get(job.id);
    expect(after?.state.runningAtMs).toBeUndefined();
    expect(after?.state.runningRunId).toBeUndefined();
    expect(after?.state.runningTimedOutAtMs).toBeUndefined();
    expect(after?.enabled).toBe(true);
    expect(after?.state.lastStatus).toBe("error");
    expect(after?.state.lastError).toBe(
      "Watchdog: exceeded 780s deadline; linked Runtime run cancelled",
    );
    expect(after?.state.lastDurationMs).toBe(780_001);
    expect(after?.state.nextRunAtMs).toBe(87_400_000);
    expect(h.runtimeCancels).toEqual([expect.objectContaining({
      reason: `cron_watchdog_timeout:${activeRunId}`, tenantId: "tenant-1", userId: "user-1",
    })]);
    expect(h.runLogs).toEqual([expect.objectContaining({
      runId: activeRunId,
      status: "error",
      error: "Watchdog: exceeded 780s deadline; linked Runtime run cancelled",
      durationMs: 780_001,
      trigger: "manual",
      attempt: 1,
    })]);
    expect(h.notifies).toHaveLength(1);
    expect(h.events.map((event) => event.type)).toEqual(["finished", "statusChanged"]);
    expect(statusEvents(h.events)[0].status).toEqual({
      enabled: true,
      jobCount: 1,
      enabledJobCount: 1,
      nextWakeAtMs: 87_400_000,
      runningJobId: undefined,
      runningJobIds: undefined,
    });
  });

  it("late watchdog completion is suppressed after linked Runtime cancellation", async () => {
    let resolveExecution!: (value: { status: "ok"; output: string }) => void;
    const execution = new Promise<{ status: "ok"; output: string }>((resolve) => {
      resolveExecution = resolve;
    });
    const h = makeHarness({ executeJob: () => execution });
    const job = await arrangeStuckJob(h, {
      name: "late-watchdog-result",
      schedule: { kind: "every", everyMs: 86_400_000 },
      payload: { kind: "agentTurn", message: "slow", timeoutSeconds: 0 },
    });

    h.clock.now = 1_000_000 + 21_780_001;
    await (h.service as any).checkStaleJobs();
    const timedOut = await h.service.get(job.id);
    expect(timedOut?.state.runningAtMs).toBeUndefined();
    expect(timedOut?.state.lastStatus).toBe("error");
    expect(h.runtimeCancels).toHaveLength(1);
    expect(h.runLogs).toHaveLength(1);

    resolveExecution({ status: "ok", output: "late success" });
    await flushMicrotasks();

    const settled = await h.service.get(job.id);
    expect(settled?.state.runningAtMs).toBeUndefined();
    expect(settled?.enabled).toBe(true);
    expect(settled?.state.lastStatus).toBe("error");
    expect(settled?.state.lastError).toBe(
      "Watchdog: exceeded 21780s deadline; linked Runtime run cancelled",
    );
    expect(h.runLogs).toHaveLength(1);
    expect(h.notifies).toHaveLength(1);
    expect(h.events.filter((event) => event.type === "finished")).toHaveLength(1);
  });

  it("falls back to 6h deadline when job timeoutSeconds=0 (no hard timeout)", async () => {
    const h = makeHarness({ executeJob: hangingExecuteJob });
    const job = await arrangeStuckJob(h, {
      name: "no-timeout",
      schedule: { kind: "every", everyMs: 86_400_000 },
      payload: { kind: "agentTurn", message: "slow", timeoutSeconds: 0 },
    });
    const activeRunId = (await h.service.get(job.id))!.state.runningRunId!;

    h.clock.now = 1_000_000 + 21_780_000;
    await (h.service as any).checkStaleJobs();
    expect((await h.service.get(job.id))?.state.runningAtMs).toBe(1_000_000);
    expect(h.runLogs).toHaveLength(0);

    h.clock.now = 1_000_000 + 21_780_001;
    await (h.service as any).checkStaleJobs();
    const after = await h.service.get(job.id);
    expect(after?.state.runningAtMs).toBeUndefined();
    expect(after?.state.runningTimedOutAtMs).toBeUndefined();
    expect(after?.enabled).toBe(true);
    expect(after?.state.lastError).toBe(
      "Watchdog: exceeded 21780s deadline; linked Runtime run cancelled",
    );
    expect(h.runtimeCancels).toHaveLength(1);
    expect(h.runLogs).toHaveLength(1);
    expect(h.runLogs[0].runId).toBe(activeRunId);
    expect(h.runLogs[0].durationMs).toBe(21_780_001);
  });

  it("cleans a stuck disabled job without rescheduling nextRun (defaultTimeoutSeconds path)", async () => {
    const h = makeHarness({ executeJob: hangingExecuteJob, defaultTimeoutSeconds: 60 });
    const job = await h.service.add({
      name: "later-disabled",
      schedule: { kind: "every", everyMs: 10_000 },
      payload: { kind: "systemEvent", text: "tick" },
    });
    await h.service.runNow(job.id);
    await h.service.update(job.id, { enabled: false });
    const activeRunId = (await h.service.get(job.id))!.state.runningRunId!;
    h.clear();

    h.clock.now = 1_240_001;
    await (h.service as any).checkStaleJobs();

    const after = await h.service.get(job.id);
    expect(after?.state.runningAtMs).toBeUndefined();
    expect(after?.state.runningTimedOutAtMs).toBeUndefined();
    expect(after?.state.lastStatus).toBe("error");
    expect(after?.state.lastError).toBe(
      "Watchdog: exceeded 240s deadline; linked Runtime run cancelled",
    );
    expect(after?.state.nextRunAtMs).toBeUndefined();
    expect(h.runtimeCancels).toHaveLength(0);
    expect(h.runLogs).toHaveLength(1);
    expect(h.runLogs[0].runId).toBe(activeRunId);
    expect(statusEvents(h.events)[0].status.enabledJobCount).toBe(0);
  });

  it("start() arms the 60s watchdog interval and stop() clears it", async () => {
    vi.useFakeTimers();
    const h = makeHarness({ executeJob: hangingExecuteJob });
    const job = await h.service.add({
      name: "hung-agent",
      schedule: { kind: "every", everyMs: 86_400_000 },
      payload: { kind: "agentTurn", message: "do it", timeoutSeconds: 600 },
    });
    await h.service.start();
    await h.service.runNow(job.id);
    const activeRunId = (await h.service.get(job.id))!.state.runningRunId!;
    h.clear();

    h.clock.now = 1_780_001;
    await vi.advanceTimersByTimeAsync(60_000);
    const timedOut = await h.service.get(job.id);
    expect(timedOut?.state.runningAtMs).toBeUndefined();
    expect(timedOut?.state.runningTimedOutAtMs).toBeUndefined();
    expect(timedOut?.enabled).toBe(true);
    expect(h.runtimeCancels).toHaveLength(1);
    expect(h.runLogs[0].runId).toBe(activeRunId);

    const second = await h.service.add({
      name: "stopped-watchdog",
      schedule: { kind: "every", everyMs: 86_400_000 },
      payload: { kind: "agentTurn", message: "do it", timeoutSeconds: 600 },
    });
    await h.service.runNow(second.id);
    expect((await h.service.get(second.id))?.state.runningAtMs).toBe(1_780_001);
    h.clear();
    h.service.stop();
    h.clock.now = 1_780_001 + 780_002;
    await vi.advanceTimersByTimeAsync(180_000);
    expect((await h.service.get(second.id))?.state.runningAtMs).toBe(1_780_001);
    expect(h.runtimeCancels).toHaveLength(0);
    expect(h.runLogs).toHaveLength(0);
  });

});

describe("cron service start/stop lifecycle", () => {
  it("stop() halts scheduling and start() re-enables it (leadership regained)", async () => {
    vi.useFakeTimers();
    const executed: string[] = [];
    const h = makeHarness({
      executeJob: async (job) => {
        executed.push(job.id);
        return { status: "ok", output: "done" };
      },
    });
    h.clock.now = 0;
    const job = await h.service.add({
      name: "every-10s",
      schedule: { kind: "every", everyMs: 10_000 },
      payload: { kind: "systemEvent", text: "tick" },
    });
    expect(job.state.nextRunAtMs).toBe(10_000);
    h.clear();

    await h.service.start();
    expect(h.service.getStatus().enabled).toBe(true);

    h.service.stop();
    expect(h.service.getStatus().enabled).toBe(false);

    // 停止期间任务到期也不执行（armTimer 已被 stop 清除且短路）
    h.clock.now = 25_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(executed).toHaveLength(0);

    // 重新 start：enabled 复位、armTimer 立即补跑到期任务
    await h.service.start();
    expect(h.service.getStatus().enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(executed).toEqual([job.id]);

    const after = await h.service.get(job.id);
    expect(after?.state.lastStatus).toBe("ok");
    // endedAt=25_000，anchor=0 → 下一次对齐到 30_000
    expect(after?.state.nextRunAtMs).toBe(30_000);

    expect(statusEvents(h.events).map((e) => e.status.enabled)).toEqual([
      true,
      false,
      true,
      true,
      true,
    ]);
  });
});

describe("cron service normalizeEverySchedule (load-time backfill)", () => {
  it("clamps everyMs to >= 1 (floor) and persists the fix", async () => {
    const jobs = [
      rawJob({ schedule: { kind: "every", everyMs: 0, anchorMs: 100 } }),
      rawJob({ schedule: { kind: "every", everyMs: -7, anchorMs: 100 } }),
      rawJob({ schedule: { kind: "every", everyMs: 2.9, anchorMs: 100 } }),
    ];
    const h = makeHarness({ loadJobs: async () => jobs });
    h.clock.now = 500_000;

    const loaded = await h.service.list({ includeDisabled: true });

    expect(loaded.map((j) => (j.schedule as any).everyMs)).toEqual([1, 1, 2]);
    expect(h.saved).toHaveLength(1); // clamp 属于 dirty，加载时即回写
  });

  it("does not backfill anchor for disabled jobs and skips persist entirely", async () => {
    const jobs = [
      rawJob({ enabled: false, schedule: { kind: "every", everyMs: 5_000 } }),
    ];
    const h = makeHarness({ loadJobs: async () => jobs });
    h.clock.now = 500_000;

    const loaded = await h.service.list({ includeDisabled: true });

    expect((loaded[0].schedule as any).anchorMs).toBeUndefined();
    expect(loaded[0].state.nextRunAtMs).toBeUndefined();
    expect(h.saved).toHaveLength(0); // 无变更 → 不落盘
  });

  it("backfills anchor = nextRunAtMs - everyMs (floors floats, clamps at 0)", async () => {
    const jobs = [
      rawJob({
        schedule: { kind: "every", everyMs: 10_000 },
        state: { nextRunAtMs: 50_000.9 },
      }),
      rawJob({
        schedule: { kind: "every", everyMs: 10_000 },
        state: { nextRunAtMs: 5_000 },
      }),
    ];
    const h = makeHarness({ loadJobs: async () => jobs });
    h.clock.now = 500_000;

    const loaded = await h.service.list({ includeDisabled: true });

    // toFiniteInt(50_000.9)=50_000 → anchor 40_000；toFiniteInt(5_000)-10_000<0 → clamp 到 0
    expect((loaded[0].schedule as any).anchorMs).toBe(40_000);
    expect((loaded[1].schedule as any).anchorMs).toBe(0);
    // 已有 nextRunAtMs 保留原值，不重算
    expect(loaded[0].state.nextRunAtMs).toBe(50_000.9);
    expect(loaded[1].state.nextRunAtMs).toBe(5_000);
    expect(h.saved).toHaveLength(1);
  });

  it("backfills anchor = now when nextRunAtMs is missing or non-finite (toFiniteInt guard)", async () => {
    const jobs = [
      rawJob({ schedule: { kind: "every", everyMs: 10_000 } }), // 无 nextRun
      rawJob({
        schedule: { kind: "every", everyMs: 10_000 },
        state: { nextRunAtMs: Number.NaN },
      }),
      rawJob({
        schedule: { kind: "every", everyMs: 10_000 },
        state: { nextRunAtMs: Number.POSITIVE_INFINITY },
      }),
    ];
    const h = makeHarness({ loadJobs: async () => jobs });
    h.clock.now = 123_456;

    const loaded = await h.service.list({ includeDisabled: true });

    expect(loaded.map((j) => (j.schedule as any).anchorMs)).toEqual([
      123_456, 123_456, 123_456,
    ]);
    // 无 nextRun 的 enabled job 加载后按新 anchor 补算下一次
    expect(loaded[0].state.nextRunAtMs).toBe(133_456);
  });
});

describe("cron runtime cancellation fencing", () => {
  it("keeps the parent claim active when the Runtime run is not yet observable", async () => {
    const h = makeHarness({
      executeJob: hangingExecuteJob,
      cancelRuntimeRun: async () => null,
    });
    const job = await h.service.add({
      name: "dispatch-race",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "run" },
    });
    const started = await h.service.runNow(job.id, { requestId: "dispatch-race-1" });
    const cancelled = await h.service.cancelRun(job.id, started.runId!);

    expect(cancelled).toEqual({ cancelled: false, error: "Runtime cancellation outcome is unknown" });
    expect((await h.service.get(job.id))?.state.runningRunId).toBe(started.runId);
    expect(h.runLogs).toHaveLength(0);
  });
});

describe("cron service hard timeout (pTimeout)", () => {
  it("cancels the linked Runtime run before recording the hard timeout", async () => {
    vi.useFakeTimers();
    const sessionCreated: Array<[string, string, string, string | undefined]> = [];
    let leaseHeld = false;
    const leaseReleased = vi.fn(async () => { leaseHeld = false; });
    const execution = new Promise<{ status: "ok"; output: string }>(() => {});
    const h = makeHarness({
      executeJob: (_job, hooks) => {
        hooks?.onSessionId?.(hooks.runtimeSessionId!, "/tmp/transcript.jsonl");
        return execution;
      },
      onSessionCreated: async (jobId, jobName, sessionId, owner) => {
        sessionCreated.push([jobId, jobName, sessionId, owner]);
      },
      tryAcquireRunLease: async () => {
        if (leaseHeld) return null;
        leaseHeld = true;
        return { release: leaseReleased };
      },
    });
    const job = await h.service.add({
      name: "one-shot",
      schedule: { kind: "at", atMs: 9_999_999_999 },
      payload: { kind: "agentTurn", message: "go", timeoutSeconds: 1 },
    }, { owner: "user-1", ownerName: "User One" });

    expect(await h.service.runNow(job.id)).toEqual({ ran: true });
    h.clear();
    h.clock.now = 1_061_000;
    await vi.advanceTimersByTimeAsync(61_000);
    await flushMicrotasks();

    const after = await h.service.get(job.id);
    expect(after?.state.runningAtMs).toBeUndefined();
    expect(after?.state.runningRunId).toBeUndefined();
    expect(after?.state.lastStatus).toBe("error");
    expect(after?.state.lastError).toBe("Error: Service-level hard timeout after 61s");
    expect(after?.enabled).toBe(true);
    expect(h.runtimeCancels).toHaveLength(1);
    expect(h.runtimeCancels[0].reason).toMatch(/^cron_timeout:/);
    expect(h.runLogs).toHaveLength(1);
    expect(h.runLogs[0]).toMatchObject({
      jobId: job.id,
      status: "error",
      error: "Error: Service-level hard timeout after 61s",
      transcriptPath: "/tmp/transcript.jsonl",
      durationMs: 61_000,
    });
    expect(h.runLogs[0].sessionId).toBe(h.runtimeCancels[0].sessionId);
    expect(sessionCreated).toEqual([[job.id, "one-shot", h.runtimeCancels[0].sessionId, "user-1"]]);
    expect(leaseReleased).toHaveBeenCalledTimes(1);
    expect(h.events.filter((event) => event.type === "finished")).toHaveLength(1);
  });

});
