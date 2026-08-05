import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadJobs, mutateJobs, saveJobs } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

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

  it("serializes concurrent transactions without losing jobs or leaving temp files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cron-store-"));
    const storePath = join(dir, "jobs.json");

    try {
      await Promise.all(Array.from({ length: 24 }, (_, index) =>
        mutateJobs((jobs) => {
          jobs.push({
            ...createJob(),
            id: `job-${index}`,
            name: `job ${index}`,
            state: { nextRunAtMs: index + 10 },
          });
          return index;
        }, { storePath }),
      ));

      const jobs = await loadJobs({ storePath });
      expect(jobs).toHaveLength(24);
      expect(new Set(jobs.map((job) => job.id)).size).toBe(24);
      expect(await readdir(dir)).toEqual(["jobs.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("atomically publishes a visible lock with complete owner metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cron-store-"));
    const storePath = join(dir, "jobs.json");
    const lockPath = `${storePath}.lock`;
    const entered = deferred();
    const release = deferred();

    try {
      const mutation = mutateJobs(async () => {
        entered.resolve();
        await release.promise;
      }, { storePath });
      await entered.promise;

      expect((await stat(lockPath)).isFile()).toBe(true);
      const owner = JSON.parse(await readFile(lockPath, "utf-8"));
      expect(owner).toMatchObject({ pid: process.pid, hostname: hostname() });
      expect(owner.token).toEqual(expect.any(String));

      release.resolve();
      await mutation;
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release.resolve();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("times out on a legacy incomplete lock instead of spinning forever", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cron-store-"));
    const storePath = join(dir, "jobs.json");
    const lockPath = `${storePath}.lock`;

    try {
      await mkdir(lockPath);
      await expect(mutateJobs(() => undefined, {
        storePath,
        lockTimeoutMs: 30,
        lockRetryMs: 1,
      })).rejects.toThrow(/Timed out acquiring cron store lock/);
      expect((await stat(lockPath)).isDirectory()).toBe(true);
      expect((await readdir(dir)).filter((name) => name.includes("candidate"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fences a writer whose lock ownership was taken over before rename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cron-store-"));
    const storePath = join(dir, "jobs.json");
    const lockPath = `${storePath}.lock`;
    const entered = deferred();
    const release = deferred();

    try {
      const oldWriter = mutateJobs(async (jobs) => {
        entered.resolve();
        await release.promise;
        jobs.push({ ...createJob(), id: "old-writer" });
      }, { storePath });
      await entered.promise;

      // Simulate a stale-lock takeover while the old process is suspended.
      await rm(lockPath, { recursive: true, force: true });
      await saveJobs([{ ...createJob(), id: "new-owner" }], { storePath });

      release.resolve();
      await expect(oldWriter).rejects.toThrow();
      expect((await loadJobs({ storePath })).map((job) => job.id)).toEqual(["new-owner"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not steal a stale-looking lock from a live owner process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cron-store-"));
    const storePath = join(dir, "jobs.json");
    const lockPath = `${storePath}.lock`;
    const ownerPath = join(lockPath, "owner.json");

    try {
      await mkdir(lockPath);
      await writeFile(ownerPath, JSON.stringify({
        token: "live-owner",
        pid: process.pid,
        hostname: hostname(),
      }), "utf-8");
      const old = new Date(Date.now() - 10_000);
      await utimes(ownerPath, old, old);

      await expect(mutateJobs(() => undefined, {
        storePath,
        staleLockMs: 10,
        lockTimeoutMs: 30,
        lockRetryMs: 1,
      })).rejects.toThrow(/Timed out acquiring cron store lock/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the injected crash-safe mutex without publishing a local lock file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cron-store-"));
    const storePath = join(dir, "jobs.json");
    let lockCalls = 0;

    try {
      await mutateJobs((jobs) => {
        jobs.push(createJob());
      }, {
        storePath,
        withLock: async (operation) => {
          lockCalls += 1;
          return operation();
        },
      });

      expect(lockCalls).toBe(1);
      expect(await loadJobs({ storePath })).toHaveLength(1);
      expect(await readdir(dir)).toEqual(["jobs.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never time-steals an abandoned file lock without a crash-safe outer mutex", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cron-store-"));
    const storePath = join(dir, "jobs.json");
    const lockPath = `${storePath}.lock`;

    try {
      await writeFile(lockPath, JSON.stringify({
        token: "dead-owner",
        pid: 2_147_483_647,
        hostname: hostname(),
      }), "utf-8");
      const old = new Date(Date.now() - 10_000);
      await utimes(lockPath, old, old);

      await expect(mutateJobs((jobs) => {
        jobs.push(createJob());
      }, {
        storePath,
        staleLockMs: 10,
        lockTimeoutMs: 30,
        lockRetryMs: 1,
      })).rejects.toThrow(/Timed out acquiring cron store lock/);
      expect(await readdir(dir)).toEqual(["jobs.json.lock"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
