import { describe, expect, it } from "vitest";

import {
  demoManifestRecordSchema,
  type DemoManifestRecord,
} from "../../../shared/src/index.js";
import {
  executeWorkflowDemoAgentStep,
  getWorkflowDemoApprovalRequests,
  initializeWorkflowDemo,
  recordWorkflowDemoExternalStep,
} from "../data/workflowDemos/engine.js";
import { InMemoryWorkflowDemoStore } from "../data/workflowDemos/store.js";

function manifest(type: DemoManifestRecord["primaryType"]): DemoManifestRecord {
  const eventDefinitions = definitions(type);
  return demoManifestRecordSchema.parse({
    id: `${type.toLowerCase()}-demo`,
    workflowId: `${type.toLowerCase()}-workflow`,
    catalogScenarioId: `${type.toLowerCase()}-catalog`,
    definitionVersion: 1,
    primaryType: type,
    environment: { kind: "isolated_stateful", dataLabel: "synthetic" },
    status: "planned",
    publication: { status: "private" },
    public: {
      title: `${type} 状态化演示`,
      environmentLabel: "隔离演示系统·合成数据",
      before: [{ id: "object-one", label: "演示业务对象", state: type === "WATCH" ? "运行正常" : "待处理" }],
      timeline: eventDefinitions.map(({ eventId, expectedState }, index) => ({
        id: eventId,
        label: `业务步骤 ${index + 1}`,
        summary: `由适配器执行并持久记录步骤 ${index + 1}`,
        state: expectedState,
      })),
      after: [{ id: "object-one", label: "演示业务对象", state: "已完成并回读" }],
      evidence: evidence(type),
    },
    internal: {
      tenantRef: "internal-test-tenant",
      accountRef: "internal-test-account",
      runIds: [],
      businessObjectRefs: [],
      idempotencyKeyHashes: [],
      beforeSnapshotRefs: [],
      timelineEventRefs: [],
      afterSnapshotRefs: [],
      evidenceRefs: [],
      executionPlan: eventDefinitions,
      reviewedBy: [],
    },
  });
}

function definitions(type: DemoManifestRecord["primaryType"]) {
  const base = {
    actorRole: "demo-workflow-agent",
    targetObjectId: "object-one",
    mutation: false,
    approvalRequired: false,
  };
  const mutation = (eventId: string, approvalRequired = false) => ({
    ...base,
    eventId,
    phase: "act" as const,
    mutation: true,
    approvalRequired,
    ...(approvalRequired ? { approvalEventRef: "approve" } : {}),
    workflowActionId: `action-${eventId}`,
    permissionRef: `permission-${eventId}`,
    approvalPolicyRef: `approval-${eventId}`,
    receiptSchemaRef: `receipt:${eventId}:v1`,
    workflowIdempotencyPolicyRef: `idempotency-policy-${eventId}`,
    operationRef: `operation:${eventId}`,
    idempotencyRef: `idempotency:${eventId}`,
    expectedState: "已完成并回读",
  });
  if (type === "WATCH") return [
    { ...base, eventId: "observe-normal", phase: "observe" as const, cycleId: "cycle-normal", observationKind: "normal" as const, expectedState: "运行正常" },
    { ...base, eventId: "wait-next-cycle", phase: "wait" as const, expectedState: "等待下一周期" },
    {
      ...base,
      eventId: "resume-exception",
      phase: "resume" as const,
      actorRole: "external-monitor-event",
      resumeSignalRef: "signal:monitor-exception",
      externalChanges: [{
        targetObjectId: "object-one",
        expectedState: "发现异常",
        operationRef: "external-operation:monitor:record-exception",
        idempotencyRef: "external-idempotency:monitor:exception-cycle",
      }],
      expectedState: "异常周期已唤醒",
    },
    { ...base, eventId: "observe-exception", phase: "observe" as const, cycleId: "cycle-exception", observationKind: "exception" as const, expectedState: "发现异常" },
    mutation("notify-and-record"),
    { ...base, eventId: "verify", phase: "verify" as const, actorRole: "independent-readback", expectedState: "已完成并回读" },
  ];
  if (type === "LOOP") return [
    { ...base, eventId: "trigger", phase: "trigger" as const, expectedState: "已触发" },
    mutation("first-action"),
    { ...base, eventId: "wait-feedback", phase: "wait" as const, expectedState: "等待反馈" },
    { ...base, eventId: "resume-feedback", phase: "resume" as const, actorRole: "external-collaborator", resumeSignalRef: "signal:human-feedback", expectedState: "收到反馈" },
    { ...base, eventId: "verify", phase: "verify" as const, actorRole: "independent-readback", expectedState: "已完成并回读" },
  ];
  if (type === "ACT") return [
    { ...base, eventId: "trigger", phase: "trigger" as const, expectedState: "已触发" },
    {
      ...base,
      eventId: "approve",
      phase: "approval" as const,
      actorRole: "tenant-admin",
      externalChanges: [{
        targetObjectId: "object-one",
        expectedState: "已批准",
        operationRef: "external-operation:approval:approve",
        idempotencyRef: "external-idempotency:approval:approve",
      }],
      expectedState: "已批准",
    },
    mutation("write-action", true),
    { ...base, eventId: "verify", phase: "verify" as const, actorRole: "independent-readback", expectedState: "已完成并回读" },
  ];
  return [
    { ...base, eventId: "trigger", phase: "trigger" as const, expectedState: "已触发" },
    mutation("create-artifact"),
    { ...base, eventId: "verify", phase: "verify" as const, actorRole: "independent-readback", expectedState: "已完成并回读" },
  ];
}

function evidence(type: DemoManifestRecord["primaryType"]): DemoManifestRecord["public"]["evidence"] {
  const values: DemoManifestRecord["public"]["evidence"] = [
    { id: "agent-run", kind: "agent_run", label: "运行记录", summary: "执行步骤来自持久运行事件" },
    { id: "readback", kind: "readback", label: "状态回读", summary: "终态来自动作后的重新查询" },
  ];
  if (type === "CREATE") values.push({ id: "artifact", kind: "artifact", label: "成果证据", summary: "成果对象可以重新读取" });
  if (type === "WATCH") values.push({ id: "cycle", kind: "cycle", label: "双周期", summary: "正常与异常周期分别记录" });
  if (type === "ACT") {
    values.push({ id: "approval", kind: "approval", label: "批准记录", summary: "另一身份提供批准" });
    values.push({ id: "receipt", kind: "receipt", label: "动作回执", summary: "适配器返回不可变写入回执" });
  }
  if (type === "LOOP") values.push({ id: "resume", kind: "resume", label: "恢复记录", summary: "另一身份提供恢复信号" });
  return values;
}

function externalSignal(
  definition: DemoManifestRecord,
  step: NonNullable<DemoManifestRecord["internal"]["executionPlan"]>[number],
  objects: Array<{ id: string; version: number }>,
  approvalDigest?: string,
) {
  const request = getWorkflowDemoApprovalRequests(definition).find((item) => item.eventId === step.eventId);
  const bindings = [
    ...(step.mutation ? [{ targetObjectId: step.targetObjectId, expectedState: step.expectedState }] : []),
    ...(step.externalChanges ?? []),
  ];
  return {
    signalId: `${step.eventId}-signal`,
    signalRef: step.phase === "approval" ? request!.signalRef : step.resumeSignalRef!,
    kind: step.phase === "approval" ? "approval" as const : "resume" as const,
    occurredAt: new Date().toISOString(),
    ...(step.phase === "approval" ? { approvalDigest: approvalDigest ?? request!.approvalDigest } : {}),
    observations: bindings.map((binding) => ({
      objectId: binding.targetObjectId,
      expectedVersion: objects.find((item) => item.id === binding.targetObjectId)!.version,
      observedState: binding.expectedState,
      sourceReceiptId: `${step.eventId}-${binding.targetObjectId}-source`,
    })),
  };
}

function agentProvenance(eventId: string, tenantId = "tenant-secret", actorUserId = "executor-secret") {
  const runtimeRunId = `runtime-${eventId}`;
  const toolCallId = `call-${eventId}`;
  return {
    runtimeSessionId: "runtime-session",
    runtimeRunId,
    toolInvocationId: `${runtimeRunId}:${toolCallId}`,
    toolCallId,
    toolId: "WorkflowDemoStep" as const,
    toolName: "WorkflowDemoStep" as const,
    toolInputDigest: "a".repeat(64),
    tenantId,
    actorUserId,
  };
}

describe("Workflow Demo truthful adapter engine", () => {
  it.each(["CREATE", "WATCH", "ACT", "LOOP"] as const)("%s 经过真实步骤、回读和类型证据门禁", async (type) => {
    const store = new InMemoryWorkflowDemoStore();
    const definition = manifest(type);
    const initialized = await initializeWorkflowDemo(store, {
      manifest: definition,
      tenantId: "tenant-secret",
      actorUserId: "executor-secret",
      idempotencyKey: `${type}-idempotency-key`,
    });

    expect(initialized.run.status).toBe("running");
    expect(initialized.objects).toEqual([
      {
        id: "object-one",
        label: "演示业务对象",
        state: type === "WATCH" ? "运行正常" : "待处理",
        version: 1,
      },
    ]);
    expect(await store.getReplayByRunId(initialized.run.runId)).toBeNull();

    let completed = false;
    for (const step of definition.internal.executionPlan!) {
      if (step.phase === "approval" || step.phase === "resume") {
        const objects = await store.readObjects(initialized.run.runId);
        const result = await recordWorkflowDemoExternalStep(store, {
          manifest: definition,
          runId: initialized.run.runId,
          externalActorUserId: "reviewer-secret",
          eventId: step.eventId,
          signal: externalSignal(definition, step, objects),
        });
        completed = result.completed;
      } else {
        const current = await store.readObjects(initialized.run.runId);
        const result = await executeWorkflowDemoAgentStep(store, agentProvenance(step.eventId), {
          manifest: definition,
          workflowRunId: initialized.run.runId,
          eventId: step.eventId,
          ...(step.mutation ? { expectedVersion: current.find((item) => item.id === step.targetObjectId)!.version } : {}),
        });
        completed = result.completed;
      }
    }

    expect(completed).toBe(true);
    const run = await store.getByRunId(initialized.run.runId);
    const snapshot = await store.getReplayByRunId(initialized.run.runId);
    expect(run?.status).toBe("passed");
    expect(snapshot?.replay.verification.readBackVerified).toBe(true);
    expect(snapshot?.replay.timeline).toHaveLength(definition.public.timeline.length);
    expect(await store.readObjects(initialized.run.runId)).toEqual([
      expect.objectContaining({ id: "object-one", state: "已完成并回读" }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("tenant-secret");
    expect(JSON.stringify(snapshot)).not.toContain("executor-secret");

    const finalStep = definition.internal.executionPlan!.at(-1)!;
    const recovered = await executeWorkflowDemoAgentStep(
      store,
      agentProvenance(`${finalStep.eventId}-response-lost-retry`),
      {
        manifest: definition,
        workflowRunId: initialized.run.runId,
        eventId: finalStep.eventId,
      },
    );
    expect(recovered).toMatchObject({
      completed: true,
      run: { status: "passed" },
      replayId: snapshot?.replayId,
    });
    expect(await store.getReplayByRunId(initialized.run.runId)).toEqual(snapshot);
    expect(await store.readEvents(initialized.run.runId)).toHaveLength(definition.public.timeline.length);

    const repeated = await initializeWorkflowDemo(store, {
      manifest: definition,
      tenantId: "tenant-secret",
      actorUserId: "executor-secret",
      idempotencyKey: `${type}-idempotency-key`,
    });
    expect(repeated.run.runId).toBe(initialized.run.runId);
    expect(JSON.stringify(repeated)).not.toContain("executionToken");
    expect(await store.readEvents(initialized.run.runId)).toHaveLength(definition.public.timeline.length);
  });

  it("写动作失败重试复用同一 mutation/receipt，不重复写入", async () => {
    const store = new InMemoryWorkflowDemoStore();
    const definition = manifest("CREATE");
    const initialized = await initializeWorkflowDemo(store, {
      manifest: definition,
      tenantId: "tenant",
      actorUserId: "executor",
      idempotencyKey: "retry-safe-key",
    });
    await executeWorkflowDemoAgentStep(store, agentProvenance("trigger", "tenant", "executor"), {
      manifest: definition,
      workflowRunId: initialized.run.runId,
      eventId: "trigger",
    });
    await executeWorkflowDemoAgentStep(store, agentProvenance("create-artifact", "tenant", "executor"), {
      manifest: definition,
      workflowRunId: initialized.run.runId,
      eventId: "create-artifact",
      expectedVersion: 1,
    });
    expect(await store.readMutations(initialized.run.runId)).toHaveLength(1);
    await expect(executeWorkflowDemoAgentStep(store, agentProvenance("create-artifact-retry", "tenant", "executor"), {
      manifest: definition,
      workflowRunId: initialized.run.runId,
      eventId: "create-artifact",
      expectedVersion: 1,
    })).rejects.toMatchObject({ code: "WORKFLOW_DEMO_STEP_ORDER_CONFLICT" });
    expect(await store.readMutations(initialized.run.runId)).toHaveLength(1);
  });

  it("执行者不能自行批准或恢复等待", async () => {
    const store = new InMemoryWorkflowDemoStore();
    const definition = manifest("ACT");
    const initialized = await initializeWorkflowDemo(store, {
      manifest: definition,
      tenantId: "tenant",
      actorUserId: "executor",
      idempotencyKey: "self-approval-key",
    });
    await executeWorkflowDemoAgentStep(store, agentProvenance("trigger-self", "tenant", "executor"), {
      manifest: definition,
      workflowRunId: initialized.run.runId,
      eventId: "trigger",
    });
    await expect(recordWorkflowDemoExternalStep(store, {
      manifest: definition,
      runId: initialized.run.runId,
      externalActorUserId: "executor",
      eventId: "approve",
      signal: externalSignal(definition, definition.internal.executionPlan![1]!, await store.readObjects(initialized.run.runId)),
    })).rejects.toMatchObject({ code: "WORKFLOW_DEMO_SELF_SIGNAL_FORBIDDEN" });
  });

  it("独立批准必须精确绑定初始化时冻结的批准摘要", async () => {
    const store = new InMemoryWorkflowDemoStore();
    const definition = manifest("ACT");
    const initialized = await initializeWorkflowDemo(store, {
      manifest: definition,
      tenantId: "tenant",
      actorUserId: "executor",
      idempotencyKey: "approval-digest-key",
    });
    await executeWorkflowDemoAgentStep(store, agentProvenance("trigger-digest", "tenant", "executor"), {
      manifest: definition,
      workflowRunId: initialized.run.runId,
      eventId: "trigger",
    });
    await expect(recordWorkflowDemoExternalStep(store, {
      manifest: definition,
      runId: initialized.run.runId,
      externalActorUserId: "reviewer",
      eventId: "approve",
      signal: externalSignal(definition, definition.internal.executionPlan![1]!, await store.readObjects(initialized.run.runId), "0".repeat(64)),
    })).rejects.toMatchObject({ code: "WORKFLOW_DEMO_APPROVAL_DIGEST_MISMATCH" });
    expect(await store.readEvents(initialized.run.runId)).toHaveLength(1);
  });
});
