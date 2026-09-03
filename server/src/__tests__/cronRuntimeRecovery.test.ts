import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
    onEvent?: CronServiceDeps["onEvent"];
    resolveOwnerTenantId?: CronServiceDeps["resolveOwnerTenantId"];
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
    onEvent: options.onEvent,
    resolveOwnerTenantId: options.resolveOwnerTenantId,
  });
}

describe("Cron Runtime recovery identity", () => {
  const dirs: string[] = [];
  const started: CronService[] = [];

  afterEach(() => {
    for (const service of started) service.stop();
    started.length = 0;
  });

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
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

  it("reuses one Session and Runtime Run across five orphan recoveries", async () => {
    const lease = crashableRunLease();
    let executeCalls = 0;
    let logged = 0;
    let runtime: Awaited<ReturnType<NonNullable<CronServiceDeps["inspectRuntimeRun"]>>> = null;
    let terminalInspections = 0;
    let startedEvents = 0;
    const gate = deferred<void>();
    const executeJob: CronServiceDeps["executeJob"] = async (_job, hooks) => {
      executeCalls += 1;
      runtime = {
        runId: hooks!.runtimeRunId!,
        sessionId: hooks!.runtimeSessionId!,
        status: "running",
      };
      await hooks?.onSessionId?.(runtime.sessionId);
      await gate.promise;
      return { status: "ok", sessionId: runtime.sessionId };
    };
    const inspectRuntimeRun: NonNullable<CronServiceDeps["inspectRuntimeRun"]> = async () => {
      if (runtime?.status === "completed") terminalInspections += 1;
      return runtime;
    };
    const { a, storePath } = await makePair({
      tryAcquireRunLease: lease.tryAcquire, executeJob, inspectRuntimeRun, runtimeRunPollMs: 5,
      appendRunLog: async () => { logged += 1; },
      onEvent: (event) => { if (event.type === "started") startedEvents += 1; },
      resolveOwnerTenantId: () => "tenant-1",
    });
    const job = await a.add({
      name: "stable-runtime-identity",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "agentTurn", message: "run" },
    }, { owner: "user-1" });
    expect(await a.runNow(job.id, { requestId: "stable-runtime-1" })).toMatchObject({ ran: true });
    await waitFor(() => executeCalls === 1);

    for (let index = 0; index < 5; index += 1) {
      lease.crashOwner();
      const recovered = createService(storePath, {
        tryAcquireRunLease: lease.tryAcquire, executeJob, inspectRuntimeRun, runtimeRunPollMs: 5,
        appendRunLog: async () => { logged += 1; },
        onEvent: (event) => { if (event.type === "started") startedEvents += 1; },
        resolveOwnerTenantId: () => "tenant-1",
      });
      await recovered.start();
      started.push(recovered);
      await waitFor(async () => (await loadJobs({ storePath }))[0]?.state.executionLedger?.[0]?.recoveryCount === index + 1);
    }

    const active = (await loadJobs({ storePath }))[0]!.state.executionLedger![0]!;
    expect(executeCalls).toBe(1);
    expect(startedEvents).toBe(1);
    expect(active.sessionId).toBe(runtime!.sessionId);
    expect(active.runtimeRunId).toBe(runtime!.runId);
    expect(active.runtimeTenantId).toBe("tenant-1");
    runtime = { ...runtime!, status: "completed" };
    gate.resolve();
    await waitFor(() => logged === 1);
    const settled = (await loadJobs({ storePath }))[0]!.state.executionLedger![0]!;
    expect(settled).toMatchObject({ status: "terminal", terminalStatus: "ok", recoveryCount: 5 });
    expect(executeCalls).toBe(1);
    // 所有旧 lease observer 都应在删除共享 Store 前观察到权威终态并完成 stale CAS。
    await waitFor(() => terminalInspections >= 5);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("redispatches a missing Runtime run exactly once with the preallocated identity", async () => {
    const lease = crashableRunLease();
    let executeCalls = 0;
    let logged = 0;
    let dispatched: { runtimeRunId?: string; runtimeSessionId?: string } | undefined;
    const { a, b, storePath } = await makePair({
      tryAcquireRunLease: lease.tryAcquire,
      executeJob: async (_job, hooks) => { executeCalls += 1; dispatched = hooks; return { status: "ok", sessionId: hooks?.runtimeSessionId }; },
      inspectRuntimeRun: async () => null,
      appendRunLog: async () => { logged += 1; },
    });
    const job = await a.add({ name: "dispatch-missing", schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "agentTurn", message: "run" } });
    const claimed = await (a as any).claimJob(job.id, { trigger: "manual", requestId: "missing-runtime-1" });
    lease.crashOwner();

    await b.start(); started.push(b);
    await waitFor(() => logged === 1);
    const stored = (await loadJobs({ storePath }))[0]!;
    expect(executeCalls).toBe(1);
    expect(dispatched).toMatchObject({ runtimeRunId: claimed.value.runtimeRunId, runtimeSessionId: claimed.value.sessionId });
    expect(stored.state.executionLedger).toHaveLength(1);
    expect(stored.state.executionLedger![0]).toMatchObject({ status: "terminal", terminalStatus: "ok", recoveryCount: 1 });
  });

  it("waits for authoritative Runtime terminal when Scheduler wins the first direct-dispatch lease", async () => {
    let inspectCalls = 0;
    const logs: Array<{ status: string; error?: string; sessionId?: string }> = [];
    const { a } = await makePair({
      executeJob: async (_job, hooks) => {
        await hooks?.onSessionId?.(hooks.runtimeSessionId!);
        return { status: "error", error: "Agent run ended without a successful terminal event" };
      },
      inspectRuntimeRun: async (runId) => ({
        runId, sessionId: "scheduler-owned-session",
        status: ++inspectCalls === 1 ? "running" : "completed",
      }),
      appendRunLog: async (entry) => { logs.push(entry); },
      runtimeRunPollMs: 5,
    });
    const job = await a.add({ name: "first-dispatch-lease-race", schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "agentTurn", message: "run" } });

    await expect(a.runNow(job.id, { requestId: "first-dispatch-race-1" })).resolves.toMatchObject({ ran: true });
    await waitFor(() => logs.length === 1);
    expect(inspectCalls).toBe(2);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: "ok", sessionId: "scheduler-owned-session" });
    expect((await a.get(job.id))?.state.executionLedger?.[0]).toMatchObject({ terminalStatus: "ok" });
  });

  it("retains the parent claim when Runtime inspection fails transiently and recovers later", async () => {
    const lease = crashableRunLease();
    let executeCalls = 0;
    let logged = 0;
    const { a, b, storePath } = await makePair({
      tryAcquireRunLease: lease.tryAcquire,
      executeJob: async () => { executeCalls += 1; return { status: "ok" }; },
      inspectRuntimeRun: async () => { throw new Error("pg unavailable"); },
      appendRunLog: async () => { logged += 1; },
    });
    const job = await a.add({ name: "inspect-transient", schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "agentTurn", message: "run" } });
    const claimed = await (a as any).claimJob(job.id, { trigger: "manual", requestId: "inspect-transient-1" });
    lease.crashOwner();

    await b.start(); started.push(b);
    await waitFor(async () => (await loadJobs({ storePath }))[0]?.state.executionLedger?.[0]?.recoveryCount === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    let stored = (await loadJobs({ storePath }))[0]!;
    expect(executeCalls).toBe(0);
    expect(logged).toBe(0);
    expect(stored.state.runningRunId).toBe(claimed.value.runId);
    expect(stored.state.executionLedger![0].terminalStatus).toBeUndefined();

    const recovered = createService(storePath, {
      tryAcquireRunLease: lease.tryAcquire, executeJob: async () => { executeCalls += 1; return { status: "ok" }; },
      inspectRuntimeRun: async () => ({ runId: claimed.value.runtimeRunId, sessionId: claimed.value.sessionId, status: "completed" }),
      appendRunLog: async () => { logged += 1; }, runtimeRunPollMs: 5,
    });
    await recovered.start(); started.push(recovered);
    await waitFor(() => logged === 1);
    stored = (await loadJobs({ storePath }))[0]!;
    expect(executeCalls).toBe(0);
    expect(stored.state.executionLedger![0]).toMatchObject({ terminalStatus: "ok", recoveryCount: 2 });
  });

  it("quarantines a legacy orphan without Runtime identity instead of redispatching or looping", async () => {
    const lease = crashableRunLease();
    let executeCalls = 0;
    let logged = 0;
    const { a, b, storePath } = await makePair({
      tryAcquireRunLease: lease.tryAcquire,
      executeJob: async () => { executeCalls += 1; return { status: "ok" }; },
      appendRunLog: async () => { logged += 1; },
    });
    const job = await a.add({
      name: "legacy-orphan",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      payload: { kind: "agentTurn", message: "run" },
    });
    await (a as any).claimJob(job.id, { trigger: "manual", requestId: "legacy-1" });
    await mutateJobs((jobs) => {
      const execution = jobs[0]!.state.executionLedger![0]!;
      delete execution.sessionId;
      delete execution.runtimeRunId;
    }, { storePath });
    lease.crashOwner();

    await b.start();
    started.push(b);
    await waitFor(() => logged === 1);
    const stored = (await loadJobs({ storePath }))[0]!;
    expect(executeCalls).toBe(0);
    expect(stored.enabled).toBe(false);
    expect(stored.state.runningRunId).toBeUndefined();
    expect(stored.state.executionLedger).toHaveLength(1);
    expect(stored.state.executionLedger![0]).toMatchObject({
      status: "terminal", terminalStatus: "error", recoveryCount: 1,
    });
  });

});
