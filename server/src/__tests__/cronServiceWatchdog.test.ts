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
  notifies: Array<{ job: CronJob; run: CronRunLogEntry; output?: string; error?: string }>;
  events: CronEvent[];
  clear: () => void;
}

function makeHarness(opts: {
  loadJobs?: CronServiceDeps["loadJobs"];
  executeJob?: CronServiceDeps["executeJob"];
  onSessionCreated?: CronServiceDeps["onSessionCreated"];
  defaultTimeoutSeconds?: number;
} = {}): Harness {
  const clock = { now: 1_000_000 };
  const saved: CronJob[][] = [];
  const runLogs: CronRunLogEntry[] = [];
  const notifies: Harness["notifies"] = [];
  const events: CronEvent[] = [];

  const service = new CronService({
    nowMs: () => clock.now,
    loadJobs: opts.loadJobs ?? (async () => []),
    saveJobs: async (jobs) => {
      saved.push(jobs.map((j) => ({ ...j })));
    },
    executeJob: opts.executeJob ?? (async () => ({ status: "ok", output: "done" })),
    appendRunLog: async (entry) => {
      runLogs.push(entry);
    },
    notify: async (args) => {
      notifies.push(args);
    },
    onSessionCreated: opts.onSessionCreated,
    onEvent: (e) => {
      events.push(e);
    },
    defaultTimeoutSeconds: opts.defaultTimeoutSeconds,
  });

  const clear = () => {
    saved.length = 0;
    runLogs.length = 0;
    notifies.length = 0;
    events.length = 0;
  };

  return { service, clock, saved, runLogs, notifies, events, clear };
}

/** executeJob 永不 resolve，模拟卡死的任务执行。 */
const hangingExecuteJob: CronServiceDeps["executeJob"] = () => new Promise(() => {});

let rawJobSeq = 0;
function rawJob(over: Partial<CronJob> & { schedule: CronJob["schedule"] }): CronJob {
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
  events.filter((e): e is Extract<CronEvent, { type: "statusChanged" }> => e.type === "statusChanged");

afterEach(() => {
  vi.useRealTimers();
});

describe("cron service watchdog", () => {
  // 通过 runNow + 永不 resolve 的 executeJob 走真实卡死路径，
  // 再直接调用私有 checkStaleJobs（不依赖 60s interval），时间由注入 nowMs 控制。
  async function arrangeStuckJob(h: Harness, create: Parameters<CronService["add"]>[0]) {
    const job = await h.service.add(create);
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

  it("force-cleans a stuck enabled job past the deadline (full causal chain)", async () => {
    const h = makeHarness({ executeJob: hangingExecuteJob });
    const job = await arrangeStuckJob(h, {
      name: "hung-agent",
      schedule: { kind: "every", everyMs: 86_400_000 }, // add 时 anchorMs=1_000_000
      payload: { kind: "agentTurn", message: "do it", timeoutSeconds: 600 },
    });

    h.clock.now = 1_780_001; // elapsed = 780_001 > deadline 780_000
    await (h.service as any).checkStaleJobs();

    // 1) job 状态：清 runningAtMs、置 error、记录时长
    const after = await h.service.get(job.id);
    expect(after?.state.runningAtMs).toBeUndefined();
    expect(after?.state.lastStatus).toBe("error");
    expect(after?.state.lastError).toBe("Watchdog: exceeded 780s deadline");
    expect(after?.state.lastDurationMs).toBe(780_001);
    // 已知行为：watchdog 不更新 lastRunAtMs（只有 executeJobInternal 会写）
    expect(after?.state.lastRunAtMs).toBeUndefined();

    // 2) enabled job 重排 nextRun：anchor=1_000_000, every=86_400_000 → 87_400_000
    expect(after?.state.nextRunAtMs).toBe(87_400_000);

    // 3) run log：runId = `${startedAt}-watchdog`
    expect(h.runLogs).toEqual([
      {
        runId: "1000000-watchdog",
        startedAtMs: 1_000_000,
        endedAtMs: 1_780_001,
        jobId: job.id,
        jobName: "hung-agent",
        status: "error",
        error: "Watchdog: exceeded 780s deadline",
        durationMs: 780_001,
      },
    ]);

    // 4) notify：携带同一份 run entry 与 error，无 output
    expect(h.notifies).toHaveLength(1);
    expect(h.notifies[0].job.id).toBe(job.id);
    expect(h.notifies[0].run).toEqual(h.runLogs[0]);
    expect(h.notifies[0].error).toBe("Watchdog: exceeded 780s deadline");
    expect(h.notifies[0].output).toBeUndefined();

    // 5) persist 一次 + finished/statusChanged 事件（顺序：finished → statusChanged）
    expect(h.saved).toHaveLength(1);
    expect(h.events.map((e) => e.type)).toEqual(["finished", "statusChanged"]);
    expect(h.events[0]).toEqual({
      type: "finished",
      jobId: job.id,
      jobName: "hung-agent",
      status: "error",
      error: "Watchdog: exceeded 780s deadline",
      durationMs: 780_001,
    });
    expect(statusEvents(h.events)[0].status).toEqual({
      enabled: true,
      jobCount: 1,
      enabledJobCount: 1,
      nextWakeAtMs: 87_400_000,
      runningJobId: undefined,
      runningJobIds: undefined,
    });
  });

  it("falls back to 6h deadline when job timeoutSeconds=0 (no hard timeout)", async () => {
    const h = makeHarness({ executeJob: hangingExecuteJob });
    const job = await arrangeStuckJob(h, {
      name: "no-timeout",
      schedule: { kind: "every", everyMs: 86_400_000 },
      payload: { kind: "agentTurn", message: "slow", timeoutSeconds: 0 },
    });

    // deadline = 6h fallback + 180s overtime = 21_780_000ms
    h.clock.now = 1_000_000 + 21_780_000; // 恰好在边界上 → 不清理
    await (h.service as any).checkStaleJobs();
    expect((await h.service.get(job.id))?.state.runningAtMs).toBe(1_000_000);
    expect(h.runLogs).toHaveLength(0);

    h.clock.now = 1_000_000 + 21_780_001; // 超过边界 → 清理
    await (h.service as any).checkStaleJobs();
    const after = await h.service.get(job.id);
    expect(after?.state.runningAtMs).toBeUndefined();
    expect(after?.state.lastError).toBe("Watchdog: exceeded 21780s deadline");
    expect(h.runLogs).toHaveLength(1);
    expect(h.runLogs[0].runId).toBe("1000000-watchdog");
    expect(h.runLogs[0].durationMs).toBe(21_780_001);
  });

  it("cleans a stuck disabled job without rescheduling nextRun (defaultTimeoutSeconds path)", async () => {
    const h = makeHarness({ executeJob: hangingExecuteJob, defaultTimeoutSeconds: 60 });
    const job = await h.service.add({
      name: "later-disabled",
      schedule: { kind: "every", everyMs: 10_000 },
      payload: { kind: "systemEvent", text: "tick" }, // 无自带超时 → 用 defaultTimeoutSeconds
    });
    await h.service.runNow(job.id);
    await h.service.update(job.id, { enabled: false }); // 运行中被禁用
    expect((await h.service.get(job.id))?.state.runningAtMs).toBe(1_000_000);
    expect((await h.service.get(job.id))?.state.nextRunAtMs).toBeUndefined();
    h.clear();

    // deadline = 60_000 + 180_000 = 240_000
    h.clock.now = 1_240_001;
    await (h.service as any).checkStaleJobs();

    const after = await h.service.get(job.id);
    expect(after?.state.runningAtMs).toBeUndefined();
    expect(after?.state.lastStatus).toBe("error");
    expect(after?.state.lastError).toBe("Watchdog: exceeded 240s deadline");
    // disabled job 不重排 nextRun
    expect(after?.state.nextRunAtMs).toBeUndefined();
    expect(h.runLogs).toHaveLength(1);
    expect(h.runLogs[0].runId).toBe("1000000-watchdog");
    expect(h.notifies).toHaveLength(1);
    expect(h.saved).toHaveLength(1);
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
    h.clear();

    // 越过 deadline 后推进 60s：interval 触发 checkStaleJobs 完成清理
    h.clock.now = 1_780_001;
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await h.service.get(job.id))?.state.runningAtMs).toBeUndefined();
    expect(h.runLogs).toHaveLength(1);
    expect(h.runLogs[0].runId).toBe("1000000-watchdog");

    // 再次卡死后 stop()：即使远超 deadline 且推进多个 interval，也不再清理
    await h.service.runNow(job.id);
    expect((await h.service.get(job.id))?.state.runningAtMs).toBe(1_780_001);
    h.service.stop();
    h.clock.now = 1_780_001 + 780_002;
    await vi.advanceTimersByTimeAsync(180_000);
    expect((await h.service.get(job.id))?.state.runningAtMs).toBe(1_780_001);
    expect(h.runLogs).toHaveLength(1);
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

    expect(statusEvents(h.events).map((e) => e.status.enabled)).toEqual([true, false, true, true]);
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
    const jobs = [rawJob({ enabled: false, schedule: { kind: "every", everyMs: 5_000 } })];
    const h = makeHarness({ loadJobs: async () => jobs });
    h.clock.now = 500_000;

    const loaded = await h.service.list({ includeDisabled: true });

    expect((loaded[0].schedule as any).anchorMs).toBeUndefined();
    expect(loaded[0].state.nextRunAtMs).toBeUndefined();
    expect(h.saved).toHaveLength(0); // 无变更 → 不落盘
  });

  it("backfills anchor = nextRunAtMs - everyMs (floors floats, clamps at 0)", async () => {
    const jobs = [
      rawJob({ schedule: { kind: "every", everyMs: 10_000 }, state: { nextRunAtMs: 50_000.9 } }),
      rawJob({ schedule: { kind: "every", everyMs: 10_000 }, state: { nextRunAtMs: 5_000 } }),
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
      rawJob({ schedule: { kind: "every", everyMs: 10_000 }, state: { nextRunAtMs: Number.NaN } }),
      rawJob({ schedule: { kind: "every", everyMs: 10_000 }, state: { nextRunAtMs: Number.POSITIVE_INFINITY } }),
    ];
    const h = makeHarness({ loadJobs: async () => jobs });
    h.clock.now = 123_456;

    const loaded = await h.service.list({ includeDisabled: true });

    expect(loaded.map((j) => (j.schedule as any).anchorMs)).toEqual([123_456, 123_456, 123_456]);
    // 无 nextRun 的 enabled job 加载后按新 anchor 补算下一次
    expect(loaded[0].state.nextRunAtMs).toBe(133_456);
  });
});

describe("cron service hard timeout (pTimeout)", () => {
  it("rejects a hung execution with the exact timeout message and records the error run", async () => {
    vi.useFakeTimers();
    const sessionCreated: Array<[string, string, string, string | undefined]> = [];
    const h = makeHarness({
      // 卡死前先通过 hook 上报 sessionId，验证 pTimeout 打断后仍可归组
      executeJob: (_job, hooks) => {
        hooks?.onSessionId?.("sess-123", "/tmp/transcript.jsonl");
        return new Promise(() => {});
      },
      onSessionCreated: async (jobId, jobName, sessionId, owner) => {
        sessionCreated.push([jobId, jobName, sessionId, owner]);
      },
    });
    const job = await h.service.add(
      {
        name: "one-shot",
        schedule: { kind: "at", atMs: 9_999_999_999 },
        payload: { kind: "agentTurn", message: "go", timeoutSeconds: 1 }, // 硬超时 = (1+60)s
      },
      { owner: "user-1", ownerName: "User One" },
    );

    expect(await h.service.runNow(job.id)).toEqual({ ran: true });
    // 运行中重复触发被拒绝
    expect(await h.service.runNow(job.id)).toEqual({ ran: false, error: "Job is already running" });
    h.clear();

    h.clock.now = 1_061_000;
    await vi.advanceTimersByTimeAsync(61_000); // 触发 pTimeout 的 setTimeout
    await flushMicrotasks();

    const after = await h.service.get(job.id);
    expect(after?.state.runningAtMs).toBeUndefined();
    expect(after?.state.lastStatus).toBe("error");
    expect(after?.state.lastError).toBe("Error: Service-level hard timeout after 61s");
    expect(after?.state.lastDurationMs).toBe(61_000);
    // kind=at 执行失败：不再调度下一次，但保持 enabled（成功才会自动禁用）
    expect(after?.state.nextRunAtMs).toBeUndefined();
    expect(after?.enabled).toBe(true);

    expect(h.runLogs).toHaveLength(1);
    expect(h.runLogs[0]).toMatchObject({
      startedAtMs: 1_000_000,
      endedAtMs: 1_061_000,
      jobId: job.id,
      jobName: "one-shot",
      status: "error",
      error: "Error: Service-level hard timeout after 61s",
      sessionId: "sess-123",
      transcriptPath: "/tmp/transcript.jsonl",
      durationMs: 61_000,
    });
    expect(h.runLogs[0].runId).toMatch(/^1000000-[0-9a-f]{8}-/); // `${startedAt}-${uuid}`

    expect(h.notifies).toHaveLength(1);
    expect(h.notifies[0].error).toBe("Error: Service-level hard timeout after 61s");
    expect(sessionCreated).toEqual([[job.id, "one-shot", "sess-123", "user-1"]]);

    const finished = h.events.find((e) => e.type === "finished");
    expect(finished).toEqual({
      type: "finished",
      jobId: job.id,
      jobName: "one-shot",
      status: "error",
      error: "Error: Service-level hard timeout after 61s",
      durationMs: 61_000,
      sessionId: "sess-123",
      owner: "user-1",
      output: undefined,
    });
  });
});
