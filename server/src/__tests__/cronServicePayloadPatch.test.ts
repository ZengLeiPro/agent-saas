import { describe, it, expect } from "vitest";
import { CronService } from "../cron/service.js";
import { cronJobPatchSchema, type CronJob } from "../cron/types.js";

function createService() {
  let now = 0;
  const service = new CronService({
    nowMs: () => now,
    loadJobs: async () => [],
    saveJobs: async (_jobs: CronJob[]) => {},
    executeJob: async () => ({ status: "ok", output: "done" }),
    appendRunLog: async () => {},
  });
  return { service, setNow: (next: number) => { now = next; } };
}

describe("cron service payload patch", () => {
  it("clears description when patching it to blank", async () => {
    const { service } = createService();
    const job = await service.add({
      name: "described job",
      description: "old description",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      payload: { kind: "systemEvent", text: "ping" },
    });

    const updated = await service.update(job.id, { description: "   " });

    expect(updated?.description).toBeUndefined();
  });

  it("patches only agentTurn model and preserves other fields", async () => {
    const { service } = createService();
    const job = await service.add({
      name: "agent job",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      payload: {
        kind: "agentTurn",
        message: "old prompt",
        model: "old-model",
        maxTurns: 3,
        context: { memory: false },
      },
    });

    const updated = await service.update(job.id, {
      payload: { model: "gpt-5.5" },
    });

    expect(updated?.payload).toEqual({
      kind: "agentTurn",
      message: "old prompt",
      model: "gpt-5.5",
      maxTurns: 3,
      context: { memory: false },
    });
  });

  it("keeps full agentTurn payload replacement semantics", async () => {
    const { service } = createService();
    const job = await service.add({
      name: "agent job",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      payload: {
        kind: "agentTurn",
        message: "old prompt",
        model: "old-model",
        maxTurns: 3,
        context: { memory: false },
      },
    });

    const updated = await service.update(job.id, {
      payload: { kind: "agentTurn", message: "new prompt" },
    });

    expect(updated?.payload).toEqual({
      kind: "agentTurn",
      message: "new prompt",
    });
  });

  it("patches only systemEvent text", async () => {
    const { service } = createService();
    const job = await service.add({
      name: "system job",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      payload: { kind: "systemEvent", text: "old" },
    });

    const updated = await service.update(job.id, {
      payload: { text: "new" },
    });

    expect(updated?.payload).toEqual({ kind: "systemEvent", text: "new" });
  });

  it("rejects agentTurn-only fields on systemEvent partial patch", async () => {
    const { service } = createService();
    const job = await service.add({
      name: "system job",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      payload: { kind: "systemEvent", text: "old" },
    });

    await expect(service.update(job.id, {
      payload: { model: "gpt-5.5" },
    })).rejects.toThrow("systemEvent payload only supports text updates");
  });

  it("allows full payload replacement across kinds", async () => {
    const { service } = createService();
    const agentJob = await service.add({
      name: "agent job",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      payload: { kind: "agentTurn", message: "old prompt", model: "old-model" },
    });

    const systemUpdated = await service.update(agentJob.id, {
      payload: { kind: "systemEvent", text: "notify" },
    });
    expect(systemUpdated?.payload).toEqual({ kind: "systemEvent", text: "notify" });

    const agentUpdated = await service.update(agentJob.id, {
      payload: { kind: "agentTurn", message: "run" },
    });
    expect(agentUpdated?.payload).toEqual({ kind: "agentTurn", message: "run" });
  });

  it("accepts model-only payload patches in schema", () => {
    const parsed = cronJobPatchSchema.safeParse({ payload: { model: "gpt-5.5" } });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown payload patch fields in schema", () => {
    const parsed = cronJobPatchSchema.safeParse({ payload: { foo: "bar" } });
    expect(parsed.success).toBe(false);
  });
});
