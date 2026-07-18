import { describe, it, expect } from "vitest";
import { computeNextRunAtMs, findDueJobs, validateCronExpr } from "../cron/scheduler.js";
import { CronService } from "../cron/service.js";
import type { CronJob } from "../cron/types.js";

describe("cron scheduler", () => {
  it("computes next run for kind=at", () => {
    expect(computeNextRunAtMs({ kind: "at", atMs: 2000 }, 1000)).toBe(2000);
    expect(computeNextRunAtMs({ kind: "at", atMs: 500 }, 1000)).toBeUndefined();
  });

  it("computes next run for kind=every", () => {
    expect(computeNextRunAtMs({ kind: "every", everyMs: 1000, anchorMs: 0 }, 0)).toBe(1000);
    expect(computeNextRunAtMs({ kind: "every", everyMs: 1000, anchorMs: 0 }, 999)).toBe(1000);
    expect(computeNextRunAtMs({ kind: "every", everyMs: 1000, anchorMs: 0 }, 1000)).toBe(2000);
  });

  it("computes next run for kind=cron (UTC)", () => {
    const now = Date.parse("2026-01-31T01:23:00.000Z");
    const next = computeNextRunAtMs({ kind: "cron", expr: "0 0 * * *", tz: "UTC" }, now);
    expect(next).toBe(Date.parse("2026-02-01T00:00:00.000Z"));
  });

  it("validates cron expressions", () => {
    expect(validateCronExpr("0 9 * * *", "UTC").valid).toBe(true);
    expect(validateCronExpr("not a cron", "UTC").valid).toBe(false);
  });
});

// ── 测试脚手架：可控 nowMs + 可挂起（不 resolve）的 executeJob ──
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// 让挂起的后台任务推进过 async ensureLoaded 到达 executeJob（一个宏任务足够冲刷微任务队列）。
async function flushMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: overrides.id ?? "job-1",
    name: overrides.name ?? "test-job",
    enabled: overrides.enabled ?? true,
    schedule: overrides.schedule ?? { kind: "every", everyMs: 10_000, anchorMs: 0 },
    payload: overrides.payload ?? { kind: "systemEvent", text: "ping" },
    createdAtMs: overrides.createdAtMs ?? 0,
    updatedAtMs: overrides.updatedAtMs ?? 0,
    state: overrides.state ?? {},
  };
}

// P0-5 cron 三层防护回归（核实-runtime-cron并发.md 候选 P0-5）：
// 1) findDueJobs 跳过 runningAtMs 任务；2) runNow 已运行守卫；3) onTimer running 重入锁。
// 目的：锁死三层闭合，防未来重构在读-判-写之间引入 await 破坏原子性。
describe("cron P0-5 concurrency guards", () => {
  // 防护 1：findDueJobs 直接单测——runningAtMs 已置位的到期任务不进入 due 列表。
  describe("findDueJobs skips running jobs", () => {
    it("excludes a due job that is already running", () => {
      const idle = makeJob({ id: "idle", state: { nextRunAtMs: 1000 } });
      const running = makeJob({ id: "running", state: { nextRunAtMs: 1000, runningAtMs: 500 } });
      const due = findDueJobs([idle, running], 2000);
      expect(due.map((j) => j.id)).toEqual(["idle"]);
    });

    it("still includes a due job once runningAtMs clears", () => {
      const job = makeJob({ id: "job", state: { nextRunAtMs: 1000, runningAtMs: 500 } });
      expect(findDueJobs([job], 2000)).toEqual([]);
      job.state.runningAtMs = undefined;
      expect(findDueJobs([job], 2000).map((j) => j.id)).toEqual(["job"]);
    });
  });

  // 防护 2：runNow 已运行守卫——runningAtMs 已置位时返回 already running 且不触发 executeJob。
  // 注意：ensureLoaded 会清理 loadJobs 带进来的陈旧 runningAtMs（service.ts:438-445，
  // "服务重启时不可能有任务还在运行"），故不能靠预置 runningAtMs 造在跑状态，
  // 必须走服务自身的 runNow 挂起长任务把 runningAtMs 真实置位（见下方 race 用例）。
  describe("runNow already-running guard", () => {
    it("returns not-found for an unknown job id", async () => {
      const service = new CronService({
        nowMs: () => 0,
        loadJobs: async () => [],
        saveJobs: async () => {},
        executeJob: async () => ({ status: "ok" }),
        appendRunLog: async () => {},
      });
      expect(await service.runNow("nope")).toEqual({ ran: false, error: "Job not found" });
    });

    it("marks the job running immediately so a concurrent runNow is rejected", async () => {
      let now = 1000;
      let executeCalls = 0;
      const hang = deferred();
      const service = new CronService({
        nowMs: () => now,
        loadJobs: async () => [
          makeJob({ id: "job-race", schedule: { kind: "at", atMs: 5000 }, state: { nextRunAtMs: 5000 } }),
        ],
        saveJobs: async () => {},
        executeJob: async () => { executeCalls++; await hang.promise; return { status: "ok" }; },
        appendRunLog: async () => {},
      });

      // 第一次 runNow 立即同步置 runningAtMs 并后台执行（executeJob 挂起）。
      const first = await service.runNow("job-race");
      expect(first).toEqual({ ran: true });
      // 第二次 runNow 命中已运行守卫 → 拒绝，executeJob 仍只被调一次。
      const second = await service.runNow("job-race");
      expect(second).toEqual({ ran: false, error: "Job is already running" });
      expect(executeCalls).toBe(1);
    });
  });

  // 防护 3：onTimer running 重入锁——并发两次 onTimer，executeJob 只跑一次。
  describe("onTimer reentrancy lock", () => {
    it("runs due jobs only once when onTimer is invoked concurrently", async () => {
      let now = 2000;
      let executeCalls = 0;
      const hang = deferred(); // 第一次 tick 的 executeJob 挂起，制造两次 tick 重叠窗口。
      const service = new CronService({
        nowMs: () => now,
        loadJobs: async () => [
          makeJob({ id: "job-timer", schedule: { kind: "at", atMs: 1000 }, state: { nextRunAtMs: 1000 } }),
        ],
        saveJobs: async () => {},
        executeJob: async () => { executeCalls++; await hang.promise; return { status: "ok" }; },
        appendRunLog: async () => {},
      });

      // 并发两次 onTimer：第一次置 this.running=true 后进入 async ensureLoaded；
      // 第二次因 this.running 已为 true 而短路直接返回（不会自己再 findDue+execute）。
      const t1 = (service as any).onTimer();
      const t2 = (service as any).onTimer();

      // 第二次 onTimer 因重入锁立即返回（不会推进到 executeJob）。
      await t2;
      // 冲刷一次宏任务，让 t1 越过 async ensureLoaded 抵达（挂起的）executeJob。
      await flushMacrotask();
      // 只有 t1 触发了一次 executeJob；t2 的短路没有贡献额外执行。
      expect(executeCalls).toBe(1);

      hang.resolve();
      await t1;
      // 放行后仍只执行一次——重入锁挡住了第二次 tick 的重复触发。
      expect(executeCalls).toBe(1);
    });
  });
});

