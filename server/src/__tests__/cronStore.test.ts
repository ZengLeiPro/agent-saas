import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadJobs, saveJobs } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";

function createJob(): CronJob {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "daily report",
    enabled: true,
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
    payload: { kind: "systemEvent", text: "ping" },
    createdAtMs: 1,
    updatedAtMs: 2,
    state: {
      nextRunAtMs: 3,
      runningAtMs: 4,
      lastRunAtMs: 5,
      lastStatus: "ok",
      lastError: "old error",
      lastDurationMs: 6,
      lastOutput: "old output",
    },
  };
}

describe("cron store", () => {
  it("does not persist last run result fields to jobs.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cron-store-"));
    const storePath = join(dir, "jobs.json");

    try {
      const job = createJob();
      await saveJobs([job], { storePath });

      const data = JSON.parse(await readFile(storePath, "utf-8"));
      expect(data.jobs[0].state).toEqual({ nextRunAtMs: 3, runningAtMs: 4 });

      expect(job.state.lastStatus).toBe("ok");
      expect(job.state.lastOutput).toBe("old output");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops old last run result fields when loading jobs.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cron-store-"));
    const storePath = join(dir, "jobs.json");

    try {
      await writeFile(
        storePath,
        JSON.stringify({ version: 2, jobs: [createJob()] }, null, 2),
        "utf-8",
      );

      const jobs = await loadJobs({ storePath });
      expect(jobs[0].state).toEqual({ nextRunAtMs: 3, runningAtMs: 4 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
