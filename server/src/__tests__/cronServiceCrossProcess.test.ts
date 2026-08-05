import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronService, type CronServiceDeps } from "../cron/service.js";
import { loadJobs, mutateJobs, saveJobs } from "../cron/store.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(assertion: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await assertion())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function createService(
  storePath: string,
  options: {
    nowMs?: () => number;
    executeJob?: CronServiceDeps["executeJob"];
    appendRunLog?: CronServiceDeps["appendRunLog"];
    notify?: CronServiceDeps["notify"];
    tryAcquireRunLease?: CronServiceDeps["tryAcquireRunLease"];
  } = {},
): CronService {
  return new CronService({
    nowMs: options.nowMs ?? (() => Date.now()),
    loadJobs: () => loadJobs({ storePath }),
    saveJobs: (jobs) => saveJobs(jobs, { storePath }),
    mutateJobs: (mutator) => mutateJobs(mutator, { storePath }),
    tryAcquireRunLease: options.tryAcquireRunLease,
    executeJob: options.executeJob ?? (async () => ({ status: "ok" })),
    appendRunLog: options.appendRunLog ?? (async () => {}),
    notify: options.notify,
  });
}

describe("CronService shared Store consistency", () => {
  const dirs: string[] = [];
  const started: CronService[] = [];

  afterEach(async () => {
    for (const service of started) service.stop();
    started.length = 0;
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makePair(options: Parameters<typeof createService>[1] = {}) {
    const dir = await mkdtemp(join(tmpdir(), "cron-service-shared-"));
    dirs.push(dir);
    const storePath = join(dir, "jobs.json");
    return {
      storePath,
      a: createService(storePath, options),
      b: createService(storePath, options),
    };
  }

  it("refreshes list/get from Store even when the service was never started", async () => {
    const { a, b } = await makePair();
    expect(await a.list({ includeDisabled: true })).toEqual([]);

    const created = await b.add({
      name: "created-by-b",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "systemEvent", text: "ping" },
    });

    expect((await a.list({ includeDisabled: true })).map((job) => job.id)).toEqual([created.id]);
    expect((await a.get(created.id))?.name).toBe("created-by-b");
  });

  it("does not lose jobs or target updates under concurrent mutations", async () => {
    const { a, b, storePath } = await makePair();
    const atMs = Date.now() + 60_000;
    const [first, second] = await Promise.all([
      a.add({
        name: "first",
        schedule: { kind: "at", atMs },
        payload: { kind: "systemEvent", text: "one" },
      }),
      b.add({
        name: "second",
        schedule: { kind: "at", atMs },
        payload: { kind: "systemEvent", text: "two" },
      }),
    ]);

    await Promise.all([
      a.update(first.id, { name: "first-updated" }),
      b.update(second.id, { name: "second-updated" }),
    ]);

    const jobs = await loadJobs({ storePath });
    expect(jobs).toHaveLength(2);
    expect(Object.fromEntries(jobs.map((job) => [job.id, job.name]))).toEqual({
      [first.id]: "first-updated",
      [second.id]: "second-updated",
    });
  });

  it("allows only one cross-process runNow claim", async () => {
    const gate = deferred<void>();
    let executeCalls = 0;
    const { a, b, storePath } = await makePair({
      executeJob: async () => {
        executeCalls += 1;
        await gate.promise;
        return { status: "ok" };
      },
    });
    const job = await a.add({
      name: "claim-once",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "systemEvent", text: "run" },
    });

    const results = await Promise.all([a.runNow(job.id), b.runNow(job.id)]);
    expect(results.filter((result) => result.ran)).toHaveLength(1);
    expect(results.filter((result) => !result.ran)).toEqual([
      { ran: false, error: "Job is already running" },
    ]);
    expect(executeCalls).toBe(1);

    gate.resolve();
    await waitFor(async () => {
      const stored = await loadJobs({ storePath });
      return stored[0]?.state.runningAtMs === undefined;
    });
  });

  it("does not notify when the executor marks an identity-revoked result as suppressed", async () => {
    let logged = 0;
    const notify = vi.fn(async () => undefined);
    const { a } = await makePair({
      executeJob: async () => ({
        status: "error",
        output: "Job owner does not exist",
        suppressNotification: true,
      }),
      appendRunLog: async () => { logged += 1; },
      notify,
    });
    const job = await a.add({
      name: "revoked-owner",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "systemEvent", text: "must not notify" },
    });

    expect(await a.runNow(job.id)).toEqual({ ran: true });
    await waitFor(() => logged === 1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("a started worker hot-reloads and executes a nearby job created elsewhere", async () => {
    let executeCalls = 0;
    let completedRuns = 0;
    const { a: worker, b: web } = await makePair({
      executeJob: async () => {
        executeCalls += 1;
        return { status: "ok" };
      },
      appendRunLog: async () => { completedRuns += 1; },
    });
    await worker.start();
    started.push(worker);

    await web.add({
      name: "new-nearby-job",
      schedule: { kind: "at", atMs: Date.now() + 100 },
      payload: { kind: "systemEvent", text: "run" },
    });

    await waitFor(() => completedRuns === 1);
    expect(executeCalls).toBe(1);
  });

  it("repairs an orphaned mixed-version run token instead of blocking forever", async () => {
    const { a, b, storePath } = await makePair();
    const job = await a.add({
      name: "orphan-token",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "systemEvent", text: "run" },
    });
    await mutateJobs((jobs) => {
      const stored = jobs.find((candidate) => candidate.id === job.id)!;
      stored.state.runningRunId = "orphan";
      stored.state.runningDeadlineAtMs = Date.now() + 60_000;
      delete stored.state.runningAtMs;
    }, { storePath });

    const listed = await b.list({ includeDisabled: true });
    expect(listed[0]?.state.runningRunId).toBeUndefined();
    expect(listed[0]?.state.runningDeadlineAtMs).toBeUndefined();
    expect((await loadJobs({ storePath }))[0]?.state.runningRunId).toBeUndefined();
  });

  it("recovers a claim owned by a crashed process on the same host", async () => {
    const { a, b, storePath } = await makePair();
    const job = await a.add({
      name: "dead-owner-claim",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "systemEvent", text: "run" },
    });
    await mutateJobs((jobs) => {
      const stored = jobs.find((candidate) => candidate.id === job.id)!;
      stored.state.runningAtMs = Date.now();
      stored.state.runningRunId = "dead-run";
      stored.state.runningDeadlineAtMs = Date.now() + 60_000;
      stored.state.runningOwnerPid = 2_147_483_647;
      stored.state.runningOwnerHostname = hostname();
    }, { storePath });

    const recovered = await b.get(job.id);
    expect(recovered?.state.runningAtMs).toBeUndefined();
    expect(recovered?.state.runningRunId).toBeUndefined();
    expect(recovered?.state.runningOwnerPid).toBeUndefined();
  });

  it("recovers a cross-host orphan only after acquiring the crash-safe run lease", async () => {
    const released = vi.fn(async () => undefined);
    const { a, storePath } = await makePair({
      tryAcquireRunLease: async () => ({ release: released }),
    });
    const job = await a.add({
      name: "remote-orphan",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "systemEvent", text: "run" },
    });
    await mutateJobs((jobs) => {
      const stored = jobs.find((candidate) => candidate.id === job.id)!;
      stored.state.runningAtMs = Date.now();
      stored.state.runningRunId = "remote-dead-run";
      stored.state.runningDeadlineAtMs = Date.now() + 60_000;
      stored.state.runningOwnerPid = 123;
      stored.state.runningOwnerHostname = "remote-host";
    }, { storePath });

    await a.start();
    await waitFor(() => released.mock.calls.length === 1);
    expect((await a.get(job.id))?.state.runningAtMs).toBeUndefined();
    a.stop();
  });

  it("does not clear a remote claim while its task-level run lease is still held", async () => {
    const { a, storePath } = await makePair({
      tryAcquireRunLease: async () => null,
    });
    const job = await a.add({
      name: "remote-active",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "systemEvent", text: "run" },
    });
    await mutateJobs((jobs) => {
      const stored = jobs.find((candidate) => candidate.id === job.id)!;
      stored.state.runningAtMs = Date.now();
      stored.state.runningRunId = "remote-live-run";
      stored.state.runningOwnerPid = 123;
      stored.state.runningOwnerHostname = "remote-host";
    }, { storePath });

    await a.start();
    expect((await a.get(job.id))?.state.runningRunId).toBe("remote-live-run");
    a.stop();
  });

  it("a hanging no-timeout scheduled job does not block later scheduler ticks", async () => {
    let now = 0;
    let quickRuns = 0;
    const never = new Promise<void>(() => {});
    const { a: worker } = await makePair({
      nowMs: () => now,
      executeJob: async (job) => {
        if (job.name === "hang") await never;
        return { status: "ok" };
      },
      appendRunLog: async (entry) => {
        if (entry.jobName !== "hang") quickRuns += 1;
      },
    });
    await worker.add({
      name: "hang",
      schedule: { kind: "at", atMs: 1_000 },
      payload: { kind: "agentTurn", message: "hang", timeoutSeconds: 0 },
    });
    await worker.add({
      name: "quick-1",
      schedule: { kind: "at", atMs: 1_000 },
      payload: { kind: "systemEvent", text: "quick" },
    });

    (worker as any).started = true;
    now = 2_000;
    await (worker as any).onTimer();
    await waitFor(() => quickRuns === 1);

    await worker.add({
      name: "quick-2",
      schedule: { kind: "at", atMs: 3_000 },
      payload: { kind: "systemEvent", text: "quick" },
    });
    now = 4_000;
    await (worker as any).onTimer();
    await waitFor(() => quickRuns === 2);
  });

  it("does not claim a due job after stop invalidates an in-flight scheduler tick", async () => {
    let now = 0;
    let executeCalls = 0;
    const { a: worker } = await makePair({
      nowMs: () => now,
      executeJob: async () => {
        executeCalls += 1;
        return { status: "ok" };
      },
    });
    await worker.add({
      name: "stop-gate",
      schedule: { kind: "at", atMs: 1_000 },
      payload: { kind: "systemEvent", text: "run" },
    });
    (worker as any).started = true;
    now = 2_000;

    const gate = deferred<void>();
    const refreshSpy = vi.spyOn(worker, "refresh").mockImplementationOnce(() => gate.promise);
    const tick = (worker as any).onTimer();
    worker.stop();
    gate.resolve();
    await tick;

    expect(executeCalls).toBe(0);
    expect((await worker.list({ includeDisabled: true }))[0]?.state.runningAtMs).toBeUndefined();
    refreshSpy.mockRestore();
  });

  it("old completion preserves a newer config and never resurrects a deleted job", async () => {
    let now = 1_000;
    let gate = deferred<void>();
    let completedRuns = 0;
    let settledExecutions = 0;
    const executeJob: CronServiceDeps["executeJob"] = async () => {
      await gate.promise;
      settledExecutions += 1;
      return { status: "ok" };
    };
    const { a, b } = await makePair({
      nowMs: () => now,
      executeJob,
      appendRunLog: async () => { completedRuns += 1; },
    });
    const job = await a.add({
      name: "editable",
      schedule: { kind: "every", everyMs: 10_000 },
      payload: { kind: "systemEvent", text: "old" },
    });

    expect(await a.runNow(job.id)).toEqual({ ran: true });
    // Same-millisecond edit still changes the optimistic updatedAt marker.
    await b.update(job.id, {
      enabled: false,
      payload: { kind: "systemEvent", text: "new" },
    });
    await b.update(job.id, {
      description: "same-millisecond second edit",
      payload: { kind: "systemEvent", text: "newest" },
    });
    gate.resolve();
    await waitFor(() => completedRuns === 1);
    const updated = await b.get(job.id);
    expect(updated?.enabled).toBe(false);
    expect(updated?.payload).toEqual({ kind: "systemEvent", text: "newest" });
    expect(updated?.description).toBe("same-millisecond second edit");
    expect(updated?.state.nextRunAtMs).toBeUndefined();

    gate = deferred<void>();
    now = 3_000;
    await b.update(job.id, { enabled: true });
    expect(await a.runNow(job.id)).toEqual({ ran: true });
    await b.remove(job.id);
    gate.resolve();
    await waitFor(() => settledExecutions === 2);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(completedRuns).toBe(1);
    expect(await a.get(job.id)).toBeUndefined();
  });
});
