import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import type { DemoManifestRecord } from "../../../shared/src/index.js";
import {
  WorkflowDemoToolProvider,
  type WorkflowDemoStepInput,
} from "../agent/workflowDemoToolProvider.js";
import type { ToolCallContext } from "../agent/toolRuntime.js";
import {
  getWorkflowDemoApprovalRequests,
  initializeWorkflowDemo,
  recordWorkflowDemoExternalStep,
} from "../data/workflowDemos/engine.js";
import {
  InMemoryWorkflowDemoStore,
  type WorkflowDemoEventRecord,
  type WorkflowDemoMutationRecord,
  type WorkflowDemoObjectState,
  type WorkflowDemoPublicReplay,
  type WorkflowDemoWaitRecord,
} from "../data/workflowDemos/store.js";
import {
  loadWorkflowLibraryV3,
  type LoadedWorkflowLibraryV3,
} from "../data/scenarios/workflowLibrary.js";
import { canonicalToolInputDigest } from "../runtime/rawAgentLoop.js";
import { InMemoryToolInvocationStore } from "../runtime/toolInvocationStore.js";

const DATA_PATH = resolve(import.meta.dirname, "../data/scenarios/workflow-library-v3.json");
const ACT_DEMO_ID = "demo-controlled-version-release-loop-v1";
const WATCH_DEMO_ID = "demo-management-exception-closure-loop-v1";
const LOOP_DEMO_ID = "demo-customer-issue-resolution-loop-v1";

type ExecutionStep = NonNullable<DemoManifestRecord["internal"]["executionPlan"]>[number];

interface CompletedPilot {
  manifest: DemoManifestRecord;
  runId: string;
  objects: WorkflowDemoObjectState[];
  events: WorkflowDemoEventRecord[];
  mutations: WorkflowDemoMutationRecord[];
  waits: WorkflowDemoWaitRecord[];
  replay: WorkflowDemoPublicReplay;
  invocationIds: string[];
  invocationStore: InMemoryToolInvocationStore;
}

describe("Workflow Demo 三个 Pilot 真实执行契约", () => {
  let library: LoadedWorkflowLibraryV3;

  beforeAll(async () => {
    library = await loadWorkflowLibraryV3(DATA_PATH);
  });

  it("ACT：全部 Agent 写动作经可信 Tool invocation，写后回读并形成 passed replay", async () => {
    const pilot = await runPilot(ACT_DEMO_ID);

    expect(pilot.manifest.primaryType).toBe("ACT");
    expect(pilot.mutations.filter((mutation) => mutation.source === "agent").length).toBeGreaterThan(0);
    expect(pilot.mutations.some((mutation) => (
      mutation.source === "agent" && mutation.workflowActionId
    ))).toBe(true);
    for (const mutation of pilot.mutations) {
      expect(mutation.after.version).toBe(mutation.before.version + 1);
      expect(pilot.objects.find((object) => object.id === mutation.objectId)?.version)
        .toBeGreaterThanOrEqual(mutation.after.version);
    }
    assertFinalObjects(pilot);
    await assertCommonCompletion(pilot);
  });

  it("WATCH：运行正常静默与异常闭环两个周期，并保存可验证观察证据", async () => {
    const pilot = await runPilot(WATCH_DEMO_ID);
    const observations = pilot.events.filter((event) => event.phase === "observe");

    expect(pilot.manifest.primaryType).toBe("WATCH");
    expect(new Set(observations.map((event) => event.observationKind))).toEqual(
      new Set(["normal", "exception"]),
    );
    expect(new Set(observations.map((event) => event.cycleId)).size).toBeGreaterThanOrEqual(2);
    for (const event of observations) {
      expect(event.readBackVerified).toBe(true);
      expect(event.observedAt).toMatch(/T/);
      expect(event.sourceSnapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(pilot.events.some((event) => event.eventId === "cycle-a-silence-check")).toBe(true);
    expect(pilot.events.some((event) => event.eventId === "cycle-b-observe")).toBe(true);
    assertFinalObjects(pilot);
    await assertCommonCompletion(pilot);
  });

  it("LOOP：每个 wait 都由结构化外部事件恢复，首次失败后继续到业务终态", async () => {
    const pilot = await runPilot(LOOP_DEMO_ID);
    const plannedWaitCount = pilot.manifest.internal.executionPlan
      ?.filter((step) => step.phase === "wait").length ?? 0;

    expect(pilot.manifest.primaryType).toBe("LOOP");
    expect(plannedWaitCount).toBeGreaterThanOrEqual(2);
    expect(pilot.waits).toHaveLength(plannedWaitCount);
    expect(pilot.waits.every((wait) => wait.status === "resumed" && wait.resumedByUserId)).toBe(true);
    expect(pilot.events.filter((event) => event.phase === "resume")).toHaveLength(plannedWaitCount);
    expect(pilot.events.find((event) => event.eventId === "readback-first-service-result"))
      .toMatchObject({ observationKind: "exception", readBackVerified: true });
    expect(pilot.events.some((event) => event.eventId === "act-reopen-case")).toBe(true);
    expect(pilot.objects.find((object) => object.id === "terminal-assertion-demo-1042")?.state)
      .toContain("SUCCEEDED");
    assertFinalObjects(pilot);
    await assertCommonCompletion(pilot);
  });

  async function runPilot(demoId: string): Promise<CompletedPilot> {
    const manifest = library.internal.demos.find((item) => item.id === demoId);
    if (!manifest) throw new Error(`权威 V3 数据缺少 Pilot: ${demoId}`);
    const plan = manifest.internal.executionPlan;
    if (!plan) throw new Error(`Pilot 缺少 executionPlan: ${demoId}`);

    const store = new InMemoryWorkflowDemoStore();
    const invocationStore = new InMemoryToolInvocationStore();
    const initialized = await initializeWorkflowDemo(store, {
      manifest,
      tenantId: "tenant-pilot",
      actorUserId: "pilot-agent-owner",
      idempotencyKey: `pilot-integration-${demoId}`,
    });
    const provider = new WorkflowDemoToolProvider({
      workflowDemoStore: store,
      toolInvocationStore: invocationStore,
      resolveManifest: async (requestedDemoId) => {
        const resolved = library.internal.demos.find((item) => item.id === requestedDemoId);
        if (!resolved) throw new Error(`未知 Demo: ${requestedDemoId}`);
        return resolved;
      },
      dispatch: { runId: initialized.run.runId, eventId: plan[0]!.eventId },
    });
    expect(initialized.replayed).toBe(false);
    expect(initialized.run.status).toBe("running");

    const approvalRequests = new Map(
      getWorkflowDemoApprovalRequests(manifest).map((request) => [request.eventId, request] as const),
    );
    const invocationIds: string[] = [];
    let externalSequence = 0;
    for (const [index, step] of plan.entries()) {
      if (step.phase === "approval" || step.phase === "resume") {
        externalSequence += 1;
        const before = await store.readObjects(initialized.run.runId);
        const bindings = externalBindings(step);
        const approvalRequest = step.phase === "approval"
          ? approvalRequests.get(step.eventId)
          : undefined;
        if (step.phase === "approval" && !approvalRequest) {
          throw new Error(`批准步骤没有冻结请求: ${step.eventId}`);
        }
        await recordWorkflowDemoExternalStep(store, {
          manifest,
          runId: initialized.run.runId,
          externalActorUserId: `pilot-external-actor-${externalSequence}`,
          eventId: step.eventId,
          signal: {
            signalId: `pilot-signal-${index + 1}`,
            signalRef: approvalRequest?.signalRef ?? step.resumeSignalRef!,
            kind: step.phase === "approval" ? "approval" : "resume",
            occurredAt: new Date(Date.UTC(2026, 6, 21, 4, index, 0)).toISOString(),
            ...(approvalRequest ? { approvalDigest: approvalRequest.approvalDigest } : {}),
            observations: bindings.map((binding, bindingIndex) => {
              const current = before.find((object) => object.id === binding.targetObjectId);
              if (!current) throw new Error(`外部信号目标不存在: ${binding.targetObjectId}`);
              return {
                objectId: binding.targetObjectId,
                expectedVersion: current.version,
                observedState: binding.expectedState,
                sourceReceiptId: `pilot-source-${index + 1}-${bindingIndex + 1}`,
              };
            }),
          },
        });
        continue;
      }

      const objects = await store.readObjects(initialized.run.runId);
      const target = objects.find((object) => object.id === step.targetObjectId);
      const input: WorkflowDemoStepInput = {
        workflowRunId: initialized.run.runId,
        eventId: step.eventId,
        ...(step.mutation && target ? { expectedVersion: target.version } : {}),
      };
      const runtimeRunId = `pilot-agent-run-${index + 1}`;
      const toolCallId = `pilot-tool-call-${index + 1}`;
      const invocationId = `${runtimeRunId}:${toolCallId}`;
      invocationIds.push(invocationId);
      await invocationStore.start({
        invocationId,
        runId: runtimeRunId,
        sessionId: `pilot-session-${demoId}`,
        toolCallId,
        toolName: "WorkflowDemoStep",
        executionTarget: "server-local",
        tenantId: "tenant-pilot",
        metadata: {
          toolId: "WorkflowDemoStep",
          toolInputDigest: canonicalToolInputDigest(input),
        },
      });
      const context: ToolCallContext = {
        channelContext: {
          channel: "web",
          user: {
            id: "pilot-agent-owner",
            username: "pilot-agent-owner",
            role: "user",
            tenantId: "tenant-pilot",
          },
        },
        workspace: { root: "/tmp/workflow-demo-pilot-test", executionTarget: "server-local" },
        sessionId: `pilot-session-${demoId}`,
        runId: runtimeRunId,
        toolCallId,
        invocationId,
      };
      try {
        const result = await provider.invoke({
          toolId: "WorkflowDemoStep",
          input,
          authorization: { approved: true, source: "policy_auto" },
        }, context);
        expect(result).toBeDefined();
        await invocationStore.complete(invocationId, "completed");
      } catch (error) {
        await invocationStore.complete(
          invocationId,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    }

    const run = await store.getByRunId(initialized.run.runId);
    const snapshot = await store.getReplayByRunId(initialized.run.runId);
    if (!run || run.status !== "passed" || !snapshot) {
      throw new Error(`Pilot 未形成 passed replay: ${demoId}`);
    }
    return {
      manifest,
      runId: initialized.run.runId,
      objects: await store.readObjects(initialized.run.runId),
      events: await store.readEvents(initialized.run.runId),
      mutations: await store.readMutations(initialized.run.runId),
      waits: await store.readWaits(initialized.run.runId),
      replay: snapshot.replay,
      invocationIds,
      invocationStore,
    };
  }
});

function externalBindings(step: ExecutionStep): Array<{ targetObjectId: string; expectedState: string }> {
  return [
    ...(step.mutation ? [{ targetObjectId: step.targetObjectId, expectedState: step.expectedState }] : []),
    ...(step.externalChanges ?? []).map((change) => ({
      targetObjectId: change.targetObjectId,
      expectedState: change.expectedState,
    })),
  ];
}

function assertFinalObjects(pilot: CompletedPilot): void {
  const comparable = (items: Array<{ id: string; label: string; state: string }>) => items
    .map(({ id, label, state }) => ({ id, label, state }))
    .sort((left, right) => left.id.localeCompare(right.id));
  expect(comparable(pilot.objects)).toEqual(comparable(pilot.manifest.public.after));
}

async function assertCommonCompletion(pilot: CompletedPilot): Promise<void> {
  const plan = pilot.manifest.internal.executionPlan!;
  const agentEvents = pilot.events.filter((event) => event.source === "agent");
  const externalEvents = pilot.events.filter((event) => event.source === "external");
  const agentMutations = pilot.mutations.filter((mutation) => mutation.source === "agent");
  const externalMutations = pilot.mutations.filter((mutation) => mutation.source === "external");

  expect(pilot.events).toHaveLength(plan.length);
  expect(pilot.events.map((event) => event.eventId)).toEqual(plan.map((step) => step.eventId));
  expect(agentEvents.length).toBeGreaterThan(0);
  expect(agentEvents.every((event) => (
    event.agentProvenance?.workflowEventId === event.eventId
    && event.agentProvenance.toolInvocationId
    && event.agentProvenance.actionBindingDigest.match(/^[a-f0-9]{64}$/)
  ))).toBe(true);
  expect(externalEvents.length).toBeGreaterThan(0);
  expect(externalEvents.every((event) => event.agentProvenance === undefined)).toBe(true);
  expect(agentMutations.every((mutation) => (
    mutation.agentProvenance?.workflowEventId
    && mutation.agentProvenance.toolInvocationId
  ))).toBe(true);
  expect(externalMutations.every((mutation) => mutation.agentProvenance === undefined)).toBe(true);
  expect(pilot.replay).toMatchObject({
    replayVersion: 1,
    status: "passed",
    verification: {
      readBackVerified: true,
      eventCount: plan.length,
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  });
  expect(pilot.invocationIds).toHaveLength(agentEvents.length);
  await expect(pilot.invocationStore.listRunning()).resolves.toEqual([]);
  for (const invocationId of pilot.invocationIds) {
    await expect(pilot.invocationStore.get(invocationId)).resolves.toMatchObject({ status: "completed" });
  }
}
