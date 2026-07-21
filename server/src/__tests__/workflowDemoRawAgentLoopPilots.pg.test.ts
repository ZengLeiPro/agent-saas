import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  loadWorkflowLibraryV3,
  type LoadedWorkflowLibraryV3,
} from "../data/scenarios/workflowLibrary.js";
import {
  executeWorkflowDemoViaRawAgentLoop,
  type RawAgentLoopPilotResult,
} from "./helpers/workflowDemoRawAgentLoopHarness.js";
import {
  createWorkflowDemoPgHarness,
  type WorkflowDemoPgHarness,
  workflowDemoPgSuiteEnabled,
} from "./helpers/workflowDemoPgHarness.js";

const DATA_PATH = resolve(import.meta.dirname, "../data/scenarios/workflow-library-v3.json");
const describePg = workflowDemoPgSuiteEnabled() ? describe : describe.skip;
const PILOTS = [
  { type: "WATCH", workflowId: "management-exception-closure-loop" },
  { type: "ACT", workflowId: "controlled-version-release-loop" },
  { type: "LOOP", workflowId: "customer-issue-resolution-loop" },
] as const;

describePg("Workflow Demo 三类 Pilot 真实 RawAgentLoop + PostgreSQL 契约", () => {
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

  for (const pilot of PILOTS) {
    it(`${pilot.type}：Agent 步骤经 RawAgentLoop/ToolRuntime，外部事件后跨 runtime run 恢复并回读终态`, async () => {
      const manifest = library.internal.demos.find((item) => item.workflowId === pilot.workflowId);
      expect(manifest, pilot.workflowId).toBeDefined();
      expect(manifest?.primaryType).toBe(pilot.type);
      const result = await executeWorkflowDemoViaRawAgentLoop({
        manifest: manifest!,
        resolveManifest: async (demoId) => {
          const resolved = library.internal.demos.find((item) => item.id === demoId);
          if (!resolved) throw new Error(`未知 Demo: ${demoId}`);
          return resolved;
        },
        workflowDemoStore: harness.store,
        tenantId: `tenant-raw-pilot-${pilot.workflowId}`,
        actorUserId: `agent-raw-pilot-${pilot.workflowId}`,
      });

      await assertRawAgentLoopContract(result);
      if (pilot.type === "WATCH") {
        expect(new Set(result.events
          .filter((event) => event.phase === "observe")
          .map((event) => event.observationKind)))
          .toEqual(new Set(["normal", "exception"]));
        expect(new Set(result.events
          .filter((event) => event.phase === "observe")
          .map((event) => event.cycleId)).size).toBeGreaterThanOrEqual(2);
      }
      if (pilot.type === "ACT") {
        expect(result.mutations.some((mutation) => (
          mutation.source === "agent" && mutation.workflowActionId
        ))).toBe(true);
      }
      if (pilot.type === "LOOP") {
        expect(result.waits.length).toBeGreaterThanOrEqual(2);
        expect(result.waits.every((wait) => wait.status === "resumed")).toBe(true);
        expect(result.events.some((event) => event.eventId === "act-reopen-case")).toBe(true);
      }
    }, 60_000);
  }
});

async function assertRawAgentLoopContract(result: RawAgentLoopPilotResult): Promise<void> {
  const plan = result.manifest.internal.executionPlan!;
  const agentSteps = plan.filter((step) => step.phase !== "approval" && step.phase !== "resume");
  const externalSteps = plan.filter((step) => step.phase === "approval" || step.phase === "resume");

  expect(result.replay.status).toBe("passed");
  expect(result.replay.verification.readBackVerified).toBe(true);
  expect(result.events).toHaveLength(plan.length);
  expect(result.invocationIds).toHaveLength(agentSteps.length);
  expect(result.segmentCount).toBeGreaterThan(1);
  expect(new Set(result.events
    .filter((event) => event.source === "external")
    .map((event) => event.eventId)))
    .toEqual(new Set(externalSteps.map((step) => step.eventId)));
  expect(result.events
    .filter((event) => event.source === "agent")
    .every((event) => event.agentProvenance?.runtimeRunId.startsWith("raw-pilot-run-")))
    .toBe(true);
  for (const invocationId of result.invocationIds) {
    expect((await result.invocationStore.get(invocationId))?.status).toBe("completed");
  }
  expect(result.runtimeEvents.filter((event) => event.type === "assistant_tool_calls"))
    .toHaveLength(agentSteps.length);
  expect(result.runtimeEvents.filter((event) => event.type === "tool_invocation_completed"))
    .toHaveLength(agentSteps.length);
  expect(result.runtimeEvents.filter((event) => event.type === "tool_result"))
    .toHaveLength(agentSteps.length);
  expect(result.modelRequests.length).toBe(agentSteps.length + result.segmentCount);
  expect(result.objects.map(({ id, label, state }) => ({ id, label, state }))
    .sort((left, right) => left.id.localeCompare(right.id)))
    .toEqual(result.manifest.public.after
      .map(({ id, label, state }) => ({ id, label, state }))
      .sort((left, right) => left.id.localeCompare(right.id)));
}
