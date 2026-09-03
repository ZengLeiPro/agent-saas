import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronService, type CronServiceDeps } from "../cron/service.js";
import { loadJobs, mutateJobs, saveJobs } from "../cron/store.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(
  assertion: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await assertion())) {
    if (Date.now() >= deadline)
      throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function crashableRunLease() {
  let holder: number | undefined;
  let sequence = 0;
  return {
    tryAcquire: async () => {
      if (holder !== undefined) return null;
      const token = ++sequence;
      holder = token;
      return { release: async () => { if (holder === token) holder = undefined; } };
    },
    crashOwner: () => { holder = undefined; },
  };
}

function createService(
  storePath: string,
  options: {
    nowMs?: () => number;
    executeJob?: CronServiceDeps["executeJob"];
    appendRunLog?: CronServiceDeps["appendRunLog"];
    notify?: CronServiceDeps["notify"];
    tryAcquireRunLease?: CronServiceDeps["tryAcquireRunLease"];
    inspectRuntimeRun?: CronServiceDeps["inspectRuntimeRun"];
    cancelRuntimeRun?: CronServiceDeps["cancelRuntimeRun"];
    runtimeRunPollMs?: number;
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
    inspectRuntimeRun: options.inspectRuntimeRun,
    cancelRuntimeRun: options.cancelRuntimeRun,
    runtimeRunPollMs: options.runtimeRunPollMs,
    notify: options.notify,
  });
}

describe("CronService shared Store consistency", () => {
  const dirs: string[] = [];
  const started: CronService[] = [];

  afterEach(async () => {
    for (const service of started) service.stop();
    started.length = 0;
    await Promise.all(
      // stop() 会取消后续调度，但已启动的跨进程落盘可能仍在收尾；Node 的 rm
      // 对 ENOTEMPTY/EBUSY 做有限重试，避免临时目录清理与最后一次写入竞争。
      dirs.splice(0).map((dir) => rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      })),
    );
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

    expect(
      (await a.list({ includeDisabled: true })).map((job) => job.id),
    ).toEqual([created.id]);
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
    await waitFor(() => executeCalls === 1);
    expect(executeCalls).toBe(1);

    gate.resolve();
    await waitFor(async () => {
      const stored = await loadJobs({ storePath });
      return stored[0]?.state.runningAtMs === undefined;
    });
  });

  it("deduplicates concurrent delivery of the same scheduled occurrence", async () => {
    let executeCalls = 0;
    const runs: Array<{ runId: string; trigger?: string; scheduledAtMs?: number; attempt?: number }> = [];
    const { a, b, storePath } = await makePair({
      executeJob: async () => {
        executeCalls += 1;
        return { status: "ok" };
      },
      appendRunLog: async (run) => {
        runs.push(run);
      },
    });
    const scheduledAtMs = Date.now() + 100;
    const job = await a.add({
      name: "same-occurrence-once",
      schedule: { kind: "at", atMs: scheduledAtMs },
      payload: { kind: "systemEvent", text: "run once" },
    });

    await Promise.all([a.start(), b.start()]);
    started.push(a, b);
    await waitFor(() => runs.length === 1);

    expect(executeCalls).toBe(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: "schedule",
      scheduledAtMs,
      attempt: 1,
    });
    const stored = (await loadJobs({ storePath })).find(
      (candidate) => candidate.id === job.id,
    )!;
    expect(stored.state.executionLedger).toHaveLength(1);
    expect(stored.state.executionLedger?.[0].idempotencyKey).toBe(
      `cron:${job.id}:schedule:${scheduledAtMs}`,
    );
  });

  it("deduplicates a manual request id and records explicit retry lineage", async () => {
    const runs: Array<{
      runId: string;
      trigger?: string;
      attempt?: number;
      retryOf?: string;
      parentRunId?: string;
    }> = [];
    const { a } = await makePair({
      appendRunLog: async (run) => {
        runs.push(run);
      },
    });
    const job = await a.add({
      name: "manual-lineage",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "systemEvent", text: "run" },
    });

    const first = await a.runNow(job.id, { requestId: "manual-req-1" });
    await waitFor(() => runs.length === 1);
    const duplicate = await a.runNow(job.id, { requestId: "manual-req-1" });
    expect(duplicate).toMatchObject({
      ran: true,
      runId: first.runId,
      requestId: "manual-req-1",
      deduplicated: true,
    });
    expect(runs).toHaveLength(1);

    const retry = await a.runNow(job.id, {
      requestId: "retry-req-1",
      retryOf: first.runId,
      parentRunId: first.runId,
      attempt: 2,
    });
    await waitFor(() => runs.length === 2);
    expect(retry.runId).not.toBe(first.runId);
    expect(runs[1]).toMatchObject({
      runId: retry.runId,
      trigger: "retry",
      attempt: 2,
      retryOf: first.runId,
      parentRunId: first.runId,
    });
  });

  it("redispatches a manual request claimed before the crashed process entered executeJob", async () => {
    const lease = crashableRunLease();
    const runs: string[] = [];
    let executeCalls = 0;
    const { a, b, storePath } = await makePair({
      tryAcquireRunLease: lease.tryAcquire,
      executeJob: async () => { executeCalls += 1; return { status: "ok" }; },
      appendRunLog: async (run) => { runs.push(run.runId); },
    });
    const job = await a.add({
      name: "manual-claim-crash",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "systemEvent", text: "run" },
    });
    const claimed = await (a as any).claimJob(job.id, {
      trigger: "manual", requestId: "manual-crash-1",
    });
    expect(claimed.value).toBeDefined();
    expect((await loadJobs({ storePath }))[0]?.state.executionLedger?.[0]).toMatchObject({
      runId: claimed.value.runId, status: "claimed", leaseVersion: 1,
    });

    lease.crashOwner();
    await b.start();
    started.push(b);
    await waitFor(() => runs.length === 1);

    const stored = (await loadJobs({ storePath }))[0]!;
    expect(executeCalls).toBe(1);
    expect(runs).toEqual([claimed.value.runId]);
    expect(stored.state.executionLedger).toHaveLength(1);
    expect(stored.state.executionLedger?.[0]).toMatchObject({
      status: "terminal", terminalStatus: "ok", leaseVersion: 2,
      requestId: "manual-crash-1",
    });
    expect(await b.runNow(job.id, { requestId: "manual-crash-1" })).toMatchObject({
      ran: true, runId: claimed.value.runId, deduplicated: true,
    });
    expect(executeCalls).toBe(1);
  });

  it("redispatches the same scheduledAt occurrence after a pre-execution crash", async () => {
    let now = 0;
    const scheduledAtMs = 1_000;
    const lease = crashableRunLease();
    const runs: Array<{ runId: string; scheduledAtMs?: number }> = [];
    const { a, b, storePath } = await makePair({
      nowMs: () => now,
      tryAcquireRunLease: lease.tryAcquire,
      appendRunLog: async (run) => { runs.push(run); },
    });
    const job = await a.add({
      name: "scheduled-claim-crash",
      schedule: { kind: "at", atMs: scheduledAtMs },
      payload: { kind: "systemEvent", text: "run" },
    });
    (a as any).started = true;
    now = 2_000;
    const claimed = await (a as any).claimJob(job.id, {
      trigger: "schedule", scheduledAtMs,
    });
    expect(claimed.value).toBeDefined();

    lease.crashOwner();
    await b.start();
    started.push(b);
    await waitFor(() => runs.length === 1);

    expect(runs[0]).toMatchObject({ runId: claimed.value.runId, scheduledAtMs });
    const ledger = (await loadJobs({ storePath }))[0]?.state.executionLedger;
    expect(ledger).toHaveLength(1);
    expect(ledger?.[0]).toMatchObject({
      idempotencyKey: `cron:${job.id}:schedule:${scheduledAtMs}`,
      status: "terminal", leaseVersion: 2,
    });
  });

  it("fences a crashed running execution before redispatch and suppresses its stale owner", async () => {
    const lease = crashableRunLease();
    let executeCalls = 0;
    let logged = 0;
    const { a, b, storePath } = await makePair({
      tryAcquireRunLease: lease.tryAcquire,
      executeJob: async () => { executeCalls += 1; return { status: "ok" }; },
      appendRunLog: async () => { logged += 1; },
    });
    const job = await a.add({
      name: "running-crash",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "systemEvent", text: "run" },
    });
    const claimed = await (a as any).claimJob(job.id, {
      trigger: "manual", requestId: "running-crash-1",
    });
    await mutateJobs((jobs) => {
      const execution = jobs[0]!.state.executionLedger![0]!;
      execution.status = "running";
      execution.runningAtMs = Date.now();
    }, { storePath });

    lease.crashOwner();
    await b.start();
    started.push(b);
    await waitFor(() => logged === 1);
    await (a as any).executeClaimedJob(claimed.value);

    const execution = (await loadJobs({ storePath }))[0]?.state.executionLedger?.[0];
    expect(executeCalls).toBe(1);
    expect(logged).toBe(1);
    expect(execution).toMatchObject({
      runId: claimed.value.runId, status: "terminal", terminalStatus: "ok", leaseVersion: 2,
    });
    expect(execution?.leaseId).not.toBe(claimed.value.leaseId);
  });

  it("allows only one of two concurrent recoverers to own the recovered dispatch", async () => {
    const lease = crashableRunLease();
    const gate = deferred<void>();
    let executeCalls = 0;
    let logged = 0;
    const { a, b, storePath } = await makePair({
      tryAcquireRunLease: lease.tryAcquire,
      executeJob: async () => { executeCalls += 1; await gate.promise; return { status: "ok" }; },
      appendRunLog: async () => { logged += 1; },
    });
    const c = createService(storePath, {
      tryAcquireRunLease: lease.tryAcquire,
      executeJob: async () => { executeCalls += 1; await gate.promise; return { status: "ok" }; },
      appendRunLog: async () => { logged += 1; },
    });
    const job = await a.add({
      name: "concurrent-recovery",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "systemEvent", text: "run" },
    });
    await (a as any).claimJob(job.id, {
      trigger: "manual", requestId: "recover-race-1",
    });
    lease.crashOwner();

    await Promise.all([b.start(), c.start()]);
    started.push(b, c);
    await waitFor(() => executeCalls === 1);
    expect((await loadJobs({ storePath }))[0]?.state.executionLedger?.[0]).toMatchObject({
      status: "running", leaseVersion: 2,
    });
    gate.resolve();
    await waitFor(() => logged === 1);
    expect(executeCalls).toBe(1);
    expect((await loadJobs({ storePath }))[0]?.state.executionLedger?.[0]).toMatchObject({
      status: "terminal", terminalStatus: "ok",
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
      appendRunLog: async () => {
        logged += 1;
      },
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
      appendRunLog: async () => {
        completedRuns += 1;
      },
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
    await mutateJobs(
      (jobs) => {
        const stored = jobs.find((candidate) => candidate.id === job.id)!;
        stored.state.runningRunId = "orphan";
        stored.state.runningDeadlineAtMs = Date.now() + 60_000;
        delete stored.state.runningAtMs;
      },
      { storePath },
    );

    const listed = await b.list({ includeDisabled: true });
    expect(listed[0]?.state.runningRunId).toBeUndefined();
    expect(listed[0]?.state.runningDeadlineAtMs).toBeUndefined();
    expect(
      (await loadJobs({ storePath }))[0]?.state.runningRunId,
    ).toBeUndefined();
  });

  it("recovers a claim owned by a crashed process on the same host", async () => {
    const { a, b, storePath } = await makePair();
    const job = await a.add({
      name: "dead-owner-claim",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "systemEvent", text: "run" },
    });
    await mutateJobs(
      (jobs) => {
        const stored = jobs.find((candidate) => candidate.id === job.id)!;
        stored.state.runningAtMs = Date.now();
        stored.state.runningRunId = "dead-run";
        stored.state.runningDeadlineAtMs = Date.now() + 60_000;
        stored.state.runningOwnerPid = 2_147_483_647;
        stored.state.runningOwnerHostname = hostname();
      },
      { storePath },
    );

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
    await mutateJobs(
      (jobs) => {
        const stored = jobs.find((candidate) => candidate.id === job.id)!;
        stored.state.runningAtMs = Date.now();
        stored.state.runningRunId = "remote-dead-run";
        stored.state.runningDeadlineAtMs = Date.now() + 60_000;
        stored.state.runningOwnerPid = 123;
        stored.state.runningOwnerHostname = "remote-host";
      },
      { storePath },
    );

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
    await mutateJobs(
      (jobs) => {
        const stored = jobs.find((candidate) => candidate.id === job.id)!;
        stored.state.runningAtMs = Date.now();
        stored.state.runningRunId = "remote-live-run";
        stored.state.runningOwnerPid = 123;
        stored.state.runningOwnerHostname = "remote-host";
      },
      { storePath },
    );

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
    const refreshSpy = vi
      .spyOn(worker, "refresh")
      .mockImplementationOnce(() => gate.promise);
    const tick = (worker as any).onTimer();
    worker.stop();
    gate.resolve();
    await tick;

    expect(executeCalls).toBe(0);
    expect(
      (await worker.list({ includeDisabled: true }))[0]?.state.runningAtMs,
    ).toBeUndefined();
    refreshSpy.mockRestore();
  });

  it("old completion preserves a newer config and never resurrects a deleted job", async () => {
    let now = 1_000;
    let gate = deferred<void>();
    let completedRuns = 0;
    let startedExecutions = 0;
    let settledExecutions = 0;
    const executeJob: CronServiceDeps["executeJob"] = async () => {
      startedExecutions += 1;
      await gate.promise;
      settledExecutions += 1;
      return { status: "ok" };
    };
    const { a, b } = await makePair({
      nowMs: () => now,
      executeJob,
      appendRunLog: async () => {
        completedRuns += 1;
      },
    });
    const job = await a.add({
      name: "editable",
      schedule: { kind: "every", everyMs: 10_000 },
      payload: { kind: "systemEvent", text: "old" },
    });

    expect(await a.runNow(job.id)).toEqual({ ran: true });
    await waitFor(() => startedExecutions === 1);
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
    await waitFor(() => startedExecutions === 2);
    await b.remove(job.id);
    gate.resolve();
    await waitFor(() => settledExecutions === 2);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(completedRuns).toBe(1);
    expect(await a.get(job.id)).toBeUndefined();
  });
});
