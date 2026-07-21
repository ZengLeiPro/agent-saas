import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  loadWorkflowLibraryV3,
  type LoadedWorkflowLibraryV3,
} from "../data/scenarios/workflowLibrary.js";
import { InMemoryToolInvocationStore } from "../runtime/toolInvocationStore.js";
import { executeWorkflowDemoManifest } from "./helpers/workflowDemoExecutionHarness.js";
import {
  createWorkflowDemoPgHarness,
  type WorkflowDemoPgHarness,
  workflowDemoPgSuiteEnabled,
} from "./helpers/workflowDemoPgHarness.js";

const DATA_PATH = resolve(import.meta.dirname, "../data/scenarios/workflow-library-v3.json");
const describePg = workflowDemoPgSuiteEnabled() ? describe : describe.skip;

describePg("Hero Workflow Demo PostgreSQL 全链", () => {
  let harness: WorkflowDemoPgHarness;
  let library: LoadedWorkflowLibraryV3;

  beforeAll(async () => {
    [harness, library] = await Promise.all([
      createWorkflowDemoPgHarness(),
      loadWorkflowLibraryV3(DATA_PATH),
    ]);
  }, 30_000);

  afterAll(async () => {
    await harness.dispose();
  }, 30_000);

  it("12 个 Hero 均在真实 PostgreSQL 中完成写入、等待恢复、回读与终态证据冻结", async () => {
    const heroWorkflowIds = library.internal.catalogScenarios
      .filter((scenario) => scenario.internal.hero?.featured === true)
      .sort((left, right) => (
        (left.internal.hero?.order ?? Number.MAX_SAFE_INTEGER)
        - (right.internal.hero?.order ?? Number.MAX_SAFE_INTEGER)
      ))
      .map((scenario) => scenario.workflowId);
    expect(heroWorkflowIds).toHaveLength(12);

    const results = [];
    for (const workflowId of heroWorkflowIds) {
      const manifest = library.internal.demos.find((candidate) => candidate.workflowId === workflowId);
      expect(manifest, workflowId).toBeDefined();
      expect(manifest?.internal.executionPlan?.length ?? 0, workflowId).toBeGreaterThan(0);
      const completed = await executeWorkflowDemoManifest({
        manifest: manifest!,
        resolveManifest: async (demoId) => {
          const resolved = library.internal.demos.find((candidate) => candidate.id === demoId);
          if (!resolved) throw new Error(`未知 Demo: ${demoId}`);
          return resolved;
        },
        tenantId: `tenant-hero-pg-${workflowId}`,
        actorUserId: `agent-hero-pg-${workflowId}`,
        workflowDemoStore: harness.store,
        toolInvocationStore: new InMemoryToolInvocationStore(),
      });
      expect(completed.replay.status, workflowId).toBe("passed");
      expect(completed.replay.verification.readBackVerified, workflowId).toBe(true);
      expect(completed.events, workflowId).toHaveLength(manifest!.internal.executionPlan!.length);
      expect(completed.objects.map(({ id, label, state }) => ({ id, label, state }))
        .sort((left, right) => left.id.localeCompare(right.id)), workflowId)
        .toEqual(manifest!.public.after
          .map(({ id, label, state }) => ({ id, label, state }))
          .sort((left, right) => left.id.localeCompare(right.id)));
      results.push({ workflowId, evidenceHash: completed.replay.verification.evidenceHash });
    }

    expect(results).toHaveLength(12);
    expect(new Set(results.map((result) => result.evidenceHash)).size).toBe(12);
  }, 120_000);
});
