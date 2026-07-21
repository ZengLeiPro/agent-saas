import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  loadWorkflowLibraryV3,
  type LoadedWorkflowLibraryV3,
} from "../data/scenarios/workflowLibrary.js";
import { executeWorkflowDemoManifest } from "./helpers/workflowDemoExecutionHarness.js";

const DATA_PATH = resolve(import.meta.dirname, "../data/scenarios/workflow-library-v3.json");

describe("Workflow Demo 全库真实状态机契约", () => {
  let library: LoadedWorkflowLibraryV3;

  beforeAll(async () => {
    library = await loadWorkflowLibraryV3(DATA_PATH);
  });

  it("28/28 均经可信 Tool invocation、外部 signal、持久事件和终态回读跑到 passed", async () => {
    expect(library.internal.demos).toHaveLength(28);
    expect(library.internal.demos.every((manifest) => (
      manifest.status === "planned"
      && manifest.publication.status === "private"
      && (manifest.internal.executionPlan?.length ?? 0) > 0
    ))).toBe(true);

    const typeCounts = new Map<string, number>();
    for (const manifest of library.internal.demos) {
      try {
        expect({
          runIds: manifest.internal.runIds,
          idempotencyKeyHashes: manifest.internal.idempotencyKeyHashes,
          beforeSnapshotRefs: manifest.internal.beforeSnapshotRefs,
          timelineEventRefs: manifest.internal.timelineEventRefs,
          afterSnapshotRefs: manifest.internal.afterSnapshotRefs,
          evidenceRefs: manifest.internal.evidenceRefs,
          reviewedBy: manifest.internal.reviewedBy,
        }, `${manifest.workflowId} 的 planned/private 静态夹具不得冒充运行证据`).toEqual({
          runIds: [],
          idempotencyKeyHashes: [],
          beforeSnapshotRefs: [],
          timelineEventRefs: [],
          afterSnapshotRefs: [],
          evidenceRefs: [],
          reviewedBy: [],
        });

        const completed = await executeWorkflowDemoManifest({
          manifest,
          resolveManifest: async (demoId) => {
            const resolved = library.internal.demos.find((item) => item.id === demoId);
            if (!resolved) throw new Error(`未知 Demo: ${demoId}`);
            return resolved;
          },
        });
        const plan = manifest.internal.executionPlan!;
        typeCounts.set(manifest.primaryType, (typeCounts.get(manifest.primaryType) ?? 0) + 1);

        expect(completed.replayedInitialization, manifest.workflowId).toBe(true);
        expect(completed.events.map((event) => event.eventId), manifest.workflowId)
          .toEqual(plan.map((step) => step.eventId));
        expect(completed.events, manifest.workflowId).toHaveLength(plan.length);
        expect(completed.objects.map(({ id, label, state }) => ({ id, label, state }))
          .sort((left, right) => left.id.localeCompare(right.id)), manifest.workflowId)
          .toEqual(manifest.public.after
            .map(({ id, label, state }) => ({ id, label, state }))
            .sort((left, right) => left.id.localeCompare(right.id)));

        const agentEvents = completed.events.filter((event) => event.source === "agent");
        const externalEvents = completed.events.filter((event) => event.source === "external");
        expect(agentEvents.every((event) => (
          event.agentProvenance?.workflowEventId === event.eventId
          && Boolean(event.agentProvenance.toolInvocationId)
          && /^[a-f0-9]{64}$/.test(event.agentProvenance.actionBindingDigest)
        )), manifest.workflowId).toBe(true);
        expect(externalEvents.every((event) => event.agentProvenance === undefined), manifest.workflowId).toBe(true);
        expect(completed.mutations.every((mutation) => (
          mutation.after.version === mutation.before.version + 1
          && (mutation.source === "external" || Boolean(mutation.agentProvenance?.toolInvocationId))
        )), manifest.workflowId).toBe(true);
        expect(completed.invocationIds, manifest.workflowId).toHaveLength(agentEvents.length);
        await expect(completed.invocationStore.listRunning(), manifest.workflowId).resolves.toEqual([]);

        expect(completed.replay, manifest.workflowId).toMatchObject({
          replayVersion: 1,
          status: "passed",
          verification: {
            readBackVerified: true,
            eventCount: plan.length,
            evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        });

        if (manifest.primaryType === "WATCH") {
          const observations = completed.events.filter((event) => event.phase === "observe");
          expect(new Set(observations.map((event) => event.observationKind)), manifest.workflowId)
            .toEqual(new Set(["normal", "exception"]));
          expect(new Set(observations.map((event) => event.cycleId)).size, manifest.workflowId)
            .toBeGreaterThanOrEqual(2);
        }
        if (manifest.primaryType === "ACT") {
          expect(completed.mutations.some((mutation) => (
            mutation.source === "agent" && Boolean(mutation.workflowActionId)
          )), manifest.workflowId).toBe(true);
        }
        if (manifest.primaryType === "LOOP") {
          const plannedWaits = plan.filter((step) => step.phase === "wait").length;
          expect(plannedWaits, manifest.workflowId).toBeGreaterThan(0);
          expect(completed.waits, manifest.workflowId).toHaveLength(plannedWaits);
          expect(completed.waits.every((wait) => wait.status === "resumed"), manifest.workflowId).toBe(true);
        }
        if (manifest.primaryType === "CREATE") {
          expect(manifest.public.evidence.some((evidence) => evidence.kind === "artifact"), manifest.workflowId)
            .toBe(true);
          expect(completed.mutations.some((mutation) => (
            mutation.source === "agent" && Boolean(mutation.workflowActionId)
          )), manifest.workflowId).toBe(true);
        }
      } catch (error) {
        throw new Error(
          `${manifest.workflowId} 全库执行失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }

    expect(Object.fromEntries(typeCounts)).toEqual({ LOOP: 15, ACT: 4, WATCH: 3, CREATE: 6 });
  });
});
