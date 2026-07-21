import type { DemoManifestRecord } from "../../../../shared/src/index.js";
import {
  WorkflowDemoToolProvider,
  type WorkflowDemoStepInput,
} from "../../agent/workflowDemoToolProvider.js";
import type { ToolCallContext } from "../../agent/toolRuntime.js";
import {
  getWorkflowDemoApprovalRequests,
  initializeWorkflowDemo,
  recordWorkflowDemoExternalStep,
} from "../../data/workflowDemos/engine.js";
import {
  InMemoryWorkflowDemoStore,
  type WorkflowDemoEventRecord,
  type WorkflowDemoMutationRecord,
  type WorkflowDemoObjectState,
  type WorkflowDemoPublicReplay,
  type WorkflowDemoStore,
  type WorkflowDemoWaitRecord,
} from "../../data/workflowDemos/store.js";
import { canonicalToolInputDigest } from "../../runtime/canonicalToolInput.js";
import {
  InMemoryToolInvocationStore,
  type ToolInvocationStore,
} from "../../runtime/toolInvocationStore.js";

type ExecutionStep = NonNullable<DemoManifestRecord["internal"]["executionPlan"]>[number];

export interface CompletedWorkflowDemo {
  manifest: DemoManifestRecord;
  runId: string;
  objects: WorkflowDemoObjectState[];
  events: WorkflowDemoEventRecord[];
  mutations: WorkflowDemoMutationRecord[];
  waits: WorkflowDemoWaitRecord[];
  replay: WorkflowDemoPublicReplay;
  invocationIds: string[];
  invocationStore: ToolInvocationStore;
  replayedInitialization: boolean;
}

export async function executeWorkflowDemoManifest(input: {
  manifest: DemoManifestRecord;
  resolveManifest: (demoId: string) => Promise<DemoManifestRecord>;
  tenantId?: string;
  actorUserId?: string;
  workflowDemoStore?: WorkflowDemoStore;
  toolInvocationStore?: ToolInvocationStore;
}): Promise<CompletedWorkflowDemo> {
  const { manifest } = input;
  const plan = manifest.internal.executionPlan;
  if (!plan || plan.length === 0) throw new Error(`${manifest.workflowId} 缺少 executionPlan`);

  const tenantId = input.tenantId ?? `tenant-library-demo-${manifest.workflowId}`;
  const actorUserId = input.actorUserId ?? `agent-library-demo-${manifest.workflowId}`;
  const store = input.workflowDemoStore ?? new InMemoryWorkflowDemoStore();
  const invocationStore = input.toolInvocationStore ?? new InMemoryToolInvocationStore();
  const idempotencyKey = `library-demo-${manifest.id}`;
  const initialized = await initializeWorkflowDemo(store, {
    manifest,
    tenantId,
    actorUserId,
    idempotencyKey,
  });
  const provider = new WorkflowDemoToolProvider({
    workflowDemoStore: store,
    toolInvocationStore: invocationStore,
    resolveManifest: input.resolveManifest,
    dispatch: { runId: initialized.run.runId, eventId: plan[0]!.eventId },
  });
  if (initialized.replayed || initialized.run.status !== "running") {
    throw new Error(`${manifest.workflowId} 首次初始化不是全新 running`);
  }

  const replayed = await initializeWorkflowDemo(store, {
    manifest,
    tenantId,
    actorUserId,
    idempotencyKey,
  });
  if (!replayed.replayed || replayed.run.runId !== initialized.run.runId) {
    throw new Error(`${manifest.workflowId} run 级幂等重放失败`);
  }

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
        throw new Error(`${manifest.workflowId}/${step.eventId} 没有冻结 approval request`);
      }
      await recordWorkflowDemoExternalStep(store, {
        manifest,
        runId: initialized.run.runId,
        externalActorUserId: `external-${manifest.workflowId}-${externalSequence}`,
        eventId: step.eventId,
        signal: {
          signalId: `signal-${manifest.workflowId}-${index + 1}`,
          signalRef: approvalRequest?.signalRef ?? step.resumeSignalRef!,
          kind: step.phase === "approval" ? "approval" : "resume",
          occurredAt: new Date(Date.UTC(2026, 6, 21, 8, index, 0)).toISOString(),
          ...(approvalRequest ? { approvalDigest: approvalRequest.approvalDigest } : {}),
          observations: bindings.map((binding, bindingIndex) => {
            const current = before.find((object) => object.id === binding.targetObjectId);
            if (!current) throw new Error(`${manifest.workflowId} 外部目标不存在: ${binding.targetObjectId}`);
            return {
              objectId: binding.targetObjectId,
              expectedVersion: current.version,
              observedState: binding.expectedState,
              sourceReceiptId: `source-${manifest.workflowId}-${index + 1}-${bindingIndex + 1}`,
            };
          }),
        },
      });
      continue;
    }

    const objects = await store.readObjects(initialized.run.runId);
    const target = objects.find((object) => object.id === step.targetObjectId);
    const toolInput: WorkflowDemoStepInput = {
      workflowRunId: initialized.run.runId,
      eventId: step.eventId,
      ...(step.mutation && target ? { expectedVersion: target.version } : {}),
    };
    const runtimeRunId = `agent-run-${manifest.workflowId}-${index + 1}`;
    const toolCallId = `tool-call-${index + 1}`;
    const invocationId = `${runtimeRunId}:${toolCallId}`;
    invocationIds.push(invocationId);
    await invocationStore.start({
      invocationId,
      runId: runtimeRunId,
      sessionId: `session-${manifest.workflowId}`,
      toolCallId,
      toolName: "WorkflowDemoStep",
      executionTarget: "server-local",
      tenantId,
      metadata: {
        toolId: "WorkflowDemoStep",
        toolInputDigest: canonicalToolInputDigest(toolInput),
      },
    });
    const context: ToolCallContext = {
      channelContext: {
        channel: "web",
        user: {
          id: actorUserId,
          username: actorUserId,
          role: "user",
          tenantId,
        },
      },
      workspace: { root: "/tmp/workflow-demo-library-test", executionTarget: "server-local" },
      sessionId: `session-${manifest.workflowId}`,
      runId: runtimeRunId,
      toolCallId,
      invocationId,
    };
    try {
      await provider.invoke({
        toolId: "WorkflowDemoStep",
        input: toolInput,
        authorization: { approved: true, source: "policy_auto" },
      }, context);
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
    throw new Error(`${manifest.workflowId} 未形成 passed replay`);
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
    replayedInitialization: replayed.replayed,
  };
}

function externalBindings(step: ExecutionStep): Array<{ targetObjectId: string; expectedState: string }> {
  return [
    ...(step.mutation ? [{ targetObjectId: step.targetObjectId, expectedState: step.expectedState }] : []),
    ...(step.externalChanges ?? []).map((change) => ({
      targetObjectId: change.targetObjectId,
      expectedState: change.expectedState,
    })),
  ];
}
