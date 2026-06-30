import { describe, it, expect } from "vitest";
import { CronService } from "../cron/service.js";
import type { CronJob } from "../cron/types.js";

describe("cron service (every anchor)", () => {
  it("runs kind=every without drift (fixed rate)", async () => {
    let now = 0;

    const service = new CronService({
      nowMs: () => now,
      loadJobs: async () => [],
      saveJobs: async (_jobs: CronJob[]) => {},
      executeJob: async () => {
        // Simulate a long-running job (5s) so drift becomes observable.
        now += 5000;
        return { status: "ok", output: "done" };
      },
      appendRunLog: async () => {},
    });

    const job = await service.add({
      name: "every-10s",
      enabled: true,
      schedule: { kind: "every", everyMs: 10_000 },
      payload: { kind: "systemEvent", text: "ping" },
    });

    expect(job.schedule.kind).toBe("every");
    expect((job.schedule as any).anchorMs).toBe(0);
    expect(job.state.nextRunAtMs).toBe(10_000);

    now = 10_000;
    await (service as any).onTimer();

    const updated = await service.get(job.id);
    expect(updated?.state.lastStatus).toBe("ok");

    // Next run must be aligned to the interval boundary (20s), not "endedAt + 10s" (25s).
    expect(updated?.state.nextRunAtMs).toBe(20_000);
  });

  it("preserves anchorMs on update when interval unchanged", async () => {
    let now = 0;

    const service = new CronService({
      nowMs: () => now,
      loadJobs: async () => [],
      saveJobs: async (_jobs: CronJob[]) => {},
      executeJob: async () => ({ status: "ok", output: "done" }),
      appendRunLog: async () => {},
    });

    const job = await service.add({
      name: "every-10s",
      enabled: true,
      schedule: { kind: "every", everyMs: 10_000 },
      payload: { kind: "systemEvent", text: "ping" },
    });

    now = 5000;
    const updated = await service.update(job.id, {
      name: "edited",
      enabled: true,
      schedule: { kind: "every", everyMs: 10_000 },
      payload: { kind: "systemEvent", text: "pong" },
    });

    expect(updated?.schedule.kind).toBe("every");
    expect((updated?.schedule as any).anchorMs).toBe(0);
    expect(updated?.state.nextRunAtMs).toBe(10_000);
  });
});

