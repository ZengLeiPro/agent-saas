import { createHash } from "node:crypto";

import {
  demoPublicEvidenceSchema,
  type DemoManifestRecord,
  type DemoPublicEvidence,
} from "../../../../shared/src/index.js";
import {
  hashWorkflowDemoIdempotencyKey,
  WorkflowDemoConflictError,
  WorkflowDemoStoreError,
  type WorkflowDemoAgentProvenance,
  type WorkflowDemoEventRecord,
  type WorkflowDemoMutationRecord,
  type WorkflowDemoObjectState,
  type WorkflowDemoPublicReplay,
  type WorkflowDemoRunRecord,
  type WorkflowDemoStore,
  type WorkflowDemoWaitRecord,
} from "./store.js";

type DemoExecutionStep = NonNullable<DemoManifestRecord["internal"]["executionPlan"]>[number];

export interface InitializeWorkflowDemoInput {
  manifest: DemoManifestRecord;
  tenantId: string;
  actorUserId: string;
  idempotencyKey: string;
}

export interface InitializeWorkflowDemoResult {
  run: WorkflowDemoRunRecord;
  replayed: boolean;
  objects: WorkflowDemoObjectState[];
}

export type WorkflowDemoAgentInvocationProvenance = Omit<
  WorkflowDemoAgentProvenance,
  "workflowEventId" | "actionBindingDigest"
>;

export interface ExecuteWorkflowDemoAgentStepInput {
  manifest: DemoManifestRecord;
  workflowRunId: string;
  eventId: string;
  expectedVersion?: number;
}

export interface ExecuteWorkflowDemoStepResult {
  run: WorkflowDemoRunRecord;
  event: WorkflowDemoEventRecord;
  objects: WorkflowDemoObjectState[];
  completed: boolean;
  replayId?: string;
}

export interface WorkflowDemoProgress {
  nextEventId: string | null;
  nextPhase: DemoExecutionStep["phase"] | null;
  awaitingExternal: boolean;
}

export interface RecordWorkflowDemoExternalStepInput {
  manifest: DemoManifestRecord;
  runId: string;
  externalActorUserId: string;
  eventId: string;
  signal: WorkflowDemoExternalSignalEnvelope;
  /** 路由按冻结计划计算；Store 会与信号同事务写 durable continuation。 */
  continuationNextEventId?: string;
}

export interface WorkflowDemoExternalSignalEnvelope {
  signalId: string;
  signalRef: string;
  kind: "approval" | "resume";
  occurredAt: string;
  approvalDigest?: string;
  observations: Array<{
    objectId: string;
    expectedVersion: number;
    observedState: string;
    sourceReceiptId: string;
  }>;
}

export interface WorkflowDemoApprovalRequest {
  eventId: string;
  signalRef: string;
  approvalDigest: string;
  actionEventIds: string[];
}

export function getWorkflowDemoApprovalRequests(
  manifest: DemoManifestRecord,
): WorkflowDemoApprovalRequest[] {
  const plan = validateManifestForExecution(manifest);
  return plan
    .filter((step) => step.phase === "approval")
    .map((approvalStep) => {
      const actions = plan.filter((step) => step.approvalEventRef === approvalStep.eventId);
      return {
        eventId: approvalStep.eventId,
        signalRef: `approval:${approvalStep.eventId}`,
        approvalDigest: digestCanonical({
          approval: projectActionBinding(approvalStep),
          actions: actions.map(projectActionBinding),
        }),
        actionEventIds: actions.map((step) => step.eventId),
      };
    });
}

/**
 * 只初始化隔离业务对象并冻结 definition/action digest。
 * 这里不会代替 Agent 执行动作，更不会把 manifest.after 写回去冒充验证成功。
 */
export async function initializeWorkflowDemo(
  store: WorkflowDemoStore,
  input: InitializeWorkflowDemoInput,
): Promise<InitializeWorkflowDemoResult> {
  const plan = validateManifestForExecution(input.manifest);
  const created = await store.getOrCreateRun({
    demoId: input.manifest.id,
    workflowId: input.manifest.workflowId,
    catalogScenarioId: input.manifest.catalogScenarioId,
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    idempotencyKey: input.idempotencyKey,
    definitionVersion: String(input.manifest.definitionVersion),
    manifestDigest: digestCanonical(input.manifest),
    actionDigest: digestCanonical(plan.map(projectActionBinding)),
    approvalDigest: digestCanonical(plan.filter((step) => step.approvalRequired || step.phase === "approval")),
  });

  if (!created.executionToken) {
    return {
      run: created.run,
      replayed: true,
      objects: await store.readObjects(created.run.runId),
    };
  }

  try {
    const objects = await store.seedObjects(
      created.run.runId,
      created.executionToken,
      input.manifest.public.before.map((item) => ({ ...item, version: 1 })),
    );
    return {
      run: created.run,
      replayed: false,
      objects,
    };
  } catch (error) {
    await store.failRun(
      created.run.runId,
      created.executionToken,
      error instanceof Error ? error.message : String(error),
    ).catch(() => undefined);
    throw error;
  }
}

/** 只有通过 Raw Agent Loop Tool Invocation 校验的调用才能推进 Agent 步骤。 */
export async function executeWorkflowDemoAgentStep(
  store: WorkflowDemoStore,
  invocationProvenance: WorkflowDemoAgentInvocationProvenance,
  input: ExecuteWorkflowDemoAgentStepInput,
): Promise<ExecuteWorkflowDemoStepResult> {
  const plan = validateManifestForExecution(input.manifest);
  const resolved = await resolveAgentStep(store, input.manifest, input.workflowRunId, input.eventId);
  const { run, step, publicEvent } = resolved;
  assertRunMatchesManifest(run, input.manifest);
  const provenance: WorkflowDemoAgentProvenance = {
    ...invocationProvenance,
    workflowEventId: step.eventId,
    actionBindingDigest: digestCanonical(projectActionBinding(step)),
  };
  if (step.phase === "approval" || step.phase === "resume") {
    throw new WorkflowDemoStoreError("批准与恢复步骤必须由另一身份提供外部信号", "WORKFLOW_DEMO_EXTERNAL_STEP_REQUIRED", 409);
  }
  await store.bindRuntimeSession(input.workflowRunId, provenance);

  if (step.phase === "verify") {
    const objects = await store.readObjectsAuthorized(input.workflowRunId, provenance);
    const isFinalStep = plan.at(-1)?.eventId === step.eventId;
    if (isFinalStep) assertReadBack(input.manifest.public.after, objects);
    else assertTargetReadBack(step, objects);
    const eventResult = resolved.recoverCompletion
      ? { event: resolved.existingEvent! }
      : await store.appendEvent(
        input.workflowRunId,
        provenance,
        eventInput(input.workflowRunId, input.manifest, step, publicEvent, true),
      );
    if (!isFinalStep) {
      return { run: await requireRun(store, input.workflowRunId), event: eventResult.event, objects, completed: false };
    }
    if (resolved.recoverCompletion && run.status === "passed") {
      const frozen = await store.getReplayByRunId(run.runId);
      if (!frozen) {
        throw new WorkflowDemoConflictError(
          "运行已完成但冻结证据不存在",
          "WORKFLOW_DEMO_REPLAY_MISSING",
        );
      }
      return {
        run,
        event: eventResult.event,
        objects,
        completed: true,
        replayId: frozen.replayId,
      };
    }
    const completed = await completeVerifiedRun(store, input.manifest, run, provenance);
    return { run: completed.run, event: eventResult.event, objects, completed: true, replayId: completed.replayId };
  }

  let objects = await store.readObjectsAuthorized(input.workflowRunId, provenance);
  let readBackVerified = false;
  if (step.mutation) {
    if (step.approvalRequired) {
      const priorEvents = await store.readEvents(input.workflowRunId);
      if (!step.approvalEventRef || !priorEvents.some((event) => (
        event.eventId === step.approvalEventRef && event.phase === "approval" && event.source === "external"
      ))) {
        throw new WorkflowDemoStoreError("写动作尚未取得独立批准", "WORKFLOW_DEMO_APPROVAL_REQUIRED", 409);
      }
    }
    const target = objects.find((object) => object.id === step.targetObjectId);
    if (!target) throw new WorkflowDemoStoreError("执行计划目标对象不存在", "WORKFLOW_DEMO_TARGET_NOT_FOUND", 409);
    if (input.expectedVersion === undefined) {
      throw new WorkflowDemoStoreError("写动作必须携带刚刚读取的对象版本", "WORKFLOW_DEMO_EXPECTED_VERSION_REQUIRED", 400);
    }
    const mutationId = deterministicId("mutation", input.workflowRunId, step.eventId);
    const existingMutation = (await store.readMutations(input.workflowRunId))
      .find((mutation) => mutation.mutationId === mutationId);
    if (!existingMutation && target.version !== input.expectedVersion) {
      throw new WorkflowDemoConflictError("业务对象已变化，请重新读取后执行", "WORKFLOW_DEMO_OBJECT_VERSION_CONFLICT");
    }
    if (existingMutation && (
      target.state !== existingMutation.after.state || target.version !== existingMutation.after.version
    )) {
      throw new WorkflowDemoConflictError("已落账动作与当前对象状态不一致", "WORKFLOW_DEMO_MUTATION_READBACK_FAILED");
    }
    const mutationExpectedVersion = existingMutation?.before.version ?? input.expectedVersion;
    await store.mutateObject(input.workflowRunId, provenance, {
      mutationId,
      ...(step.workflowActionId ? { workflowActionId: step.workflowActionId } : {}),
      objectId: step.targetObjectId,
      expectedVersion: mutationExpectedVersion,
      nextState: step.expectedState,
      receiptId: deterministicId("receipt", input.workflowRunId, step.eventId),
      actionDigest: provenance.actionBindingDigest,
    });
    objects = await store.readObjectsAuthorized(input.workflowRunId, provenance);
    const updated = objects.find((object) => object.id === step.targetObjectId);
    const minimumVersion = existingMutation?.after.version ?? mutationExpectedVersion + 1;
    if (!updated || updated.state !== step.expectedState || updated.version < minimumVersion) {
      throw new WorkflowDemoConflictError("写动作回读未命中预期状态", "WORKFLOW_DEMO_MUTATION_READBACK_FAILED");
    }
    readBackVerified = true;
  } else if (step.phase === "observe") {
    assertTargetReadBack(step, objects);
    readBackVerified = true;
  }

  if (step.phase === "wait") {
    const resumeStep = plan[plan.indexOf(step) + 1];
    if (!resumeStep || resumeStep.phase !== "resume" || !resumeStep.resumeSignalRef) {
      throw new WorkflowDemoStoreError("等待步骤缺少紧随其后的恢复信号", "WORKFLOW_DEMO_RESUME_PLAN_MISSING", 409);
    }
    await store.beginWait(input.workflowRunId, provenance, {
      waitId: step.eventId,
      reason: publicEvent.summary,
      resumeConditionDigest: digestCanonical(resumeStep.resumeSignalRef),
    });
  }

  const eventResult = await store.appendEvent(
    input.workflowRunId,
    provenance,
    eventInput(
      input.workflowRunId,
      input.manifest,
      step,
      publicEvent,
      readBackVerified,
      step.phase === "observe" ? buildObservationEvidence(step, objects) : undefined,
    ),
  );
  return { run: await requireRun(store, input.workflowRunId), event: eventResult.event, objects, completed: false };
}

/** 只以已落库事件数和冻结计划计算进度；模型文本不参与完成判定。 */
export async function getWorkflowDemoProgress(
  store: WorkflowDemoStore,
  manifest: DemoManifestRecord,
  run: WorkflowDemoRunRecord,
): Promise<WorkflowDemoProgress> {
  const plan = validateManifestForExecution(manifest);
  const events = await store.readEvents(run.runId);
  const next = plan[events.length];
  return {
    nextEventId: next?.eventId ?? null,
    nextPhase: next?.phase ?? null,
    awaitingExternal: run.status === "waiting"
      || next?.phase === "approval"
      || next?.phase === "resume",
  };
}

/** 批准/客户回复/人工确认等外部信号必须由非运行创建者提交。 */
export async function recordWorkflowDemoExternalStep(
  store: WorkflowDemoStore,
  input: RecordWorkflowDemoExternalStepInput,
): Promise<ExecuteWorkflowDemoStepResult> {
  validateManifestForExecution(input.manifest);
  const { run, step, publicEvent } = await resolveExternalStep(store, input.manifest, input.runId, input.eventId);
  assertRunMatchesManifest(run, input.manifest);
  if (step.phase !== "approval" && step.phase !== "resume") {
    throw new WorkflowDemoStoreError(
      "当前步骤不是外部批准或恢复信号",
      "WORKFLOW_DEMO_AGENT_STEP_REQUIRED",
      409,
    );
  }
  const approvalRequest = step.phase === "approval"
    ? getWorkflowDemoApprovalRequests(input.manifest).find((item) => item.eventId === step.eventId)
    : undefined;
  const expectedSignalRef = step.phase === "approval" ? approvalRequest?.signalRef : step.resumeSignalRef;
  const expectedKind = step.phase === "approval" ? "approval" : "resume";
  if (input.signal.kind !== expectedKind || !expectedSignalRef || input.signal.signalRef !== expectedSignalRef) {
    throw new WorkflowDemoConflictError(
      "外部信号类型或来源引用与冻结步骤不一致",
      "WORKFLOW_DEMO_SIGNAL_REF_MISMATCH",
    );
  }
  if (step.phase === "approval" && (!approvalRequest || input.signal.approvalDigest !== approvalRequest.approvalDigest)) {
    throw new WorkflowDemoConflictError(
      "批准内容与本次冻结的动作摘要不一致",
      "WORKFLOW_DEMO_APPROVAL_DIGEST_MISMATCH",
    );
  }
  if (step.phase === "resume" && input.signal.approvalDigest !== undefined) {
    throw new WorkflowDemoConflictError("恢复信号不得携带批准摘要", "WORKFLOW_DEMO_SIGNAL_REF_MISMATCH");
  }
  const signalDigest = digestCanonical(input.signal);
  const objectsBefore = await store.readObjects(input.runId);
  const externalBindings = [
    ...(step.mutation ? [{
      targetObjectId: step.targetObjectId,
      expectedState: step.expectedState,
      operationRef: step.operationRef!,
      idempotencyRef: step.idempotencyRef!,
    }] : []),
    ...(step.externalChanges ?? []),
  ];
  const observationsByObject = new Map(input.signal.observations.map((item) => [item.objectId, item] as const));
  if (observationsByObject.size !== input.signal.observations.length
    || observationsByObject.size !== externalBindings.length
    || externalBindings.some((binding) => {
      const observation = observationsByObject.get(binding.targetObjectId);
      return !observation || observation.observedState !== binding.expectedState;
    })) {
    throw new WorkflowDemoConflictError("外部信号对象事实与冻结动作不一致", "WORKFLOW_DEMO_SIGNAL_FACTS_MISMATCH");
  }
  const mutations = externalBindings.map((binding) => {
    const mutationId = deterministicId("external-mutation", input.runId, `${step.eventId}:${binding.targetObjectId}`);
    const observation = observationsByObject.get(binding.targetObjectId)!;
    const target = objectsBefore.find((object) => object.id === binding.targetObjectId);
    if (!target) {
      throw new WorkflowDemoStoreError("外部信号目标对象不存在", "WORKFLOW_DEMO_TARGET_NOT_FOUND", 409);
    }
    return {
      mutationId,
      ...(step.workflowActionId ? { workflowActionId: step.workflowActionId } : {}),
      objectId: binding.targetObjectId,
      expectedVersion: observation.expectedVersion,
      nextState: binding.expectedState,
      receiptId: deterministicId("external-receipt", input.runId, `${step.eventId}:${binding.targetObjectId}`),
      actionDigest: digestCanonical({ binding, sourceReceiptId: observation.sourceReceiptId }),
    };
  });
  if (externalBindings.length === 0 && step.phase === "approval") assertTargetReadBack(step, objectsBefore);
  const plan = input.manifest.internal.executionPlan!;
  const index = plan.findIndex((item) => item.eventId === step.eventId);
  const nextStep = plan[index + 1];
  if (input.continuationNextEventId !== undefined && (
    !nextStep
    || nextStep.eventId !== input.continuationNextEventId
    || nextStep.phase === "approval"
    || nextStep.phase === "resume"
  )) {
    throw new WorkflowDemoConflictError("续跑目标与冻结计划不一致", "WORKFLOW_DEMO_CONTINUATION_CONFLICT");
  }
  const waitStep = step.phase === "resume" ? plan[index - 1] : undefined;
  if (step.phase === "resume" && (!waitStep || waitStep.phase !== "wait")) {
    throw new WorkflowDemoStoreError("恢复步骤没有对应等待点", "WORKFLOW_DEMO_WAIT_PLAN_MISSING", 409);
  }
  const event = eventInput(input.runId, input.manifest, step, publicEvent, true);
  const wait = waitStep ? {
    waitId: waitStep.eventId,
    expectedResumeConditionDigest: digestCanonical(input.signal.signalRef),
  } : undefined;
  const transactionDigest = digestCanonical({ signal: input.signal, mutations, wait: wait ?? null, event });
  const applied = await store.applyExternalSignal({
    runId: input.runId,
    externalActorUserId: input.externalActorUserId,
    signalId: input.signal.signalId,
    signalDigest,
    transactionDigest,
    mutations,
    ...(wait ? { wait } : {}),
    event,
    ...(input.continuationNextEventId ? {
      continuation: {
        externalSignalId: input.signal.signalId,
        nextEventId: input.continuationNextEventId,
      },
    } : {}),
  });
  const objectsAfter = applied.objects;
  for (const binding of externalBindings) {
    const object = objectsAfter.find((item) => item.id === binding.targetObjectId);
    if (!object || object.state !== binding.expectedState) {
      throw new WorkflowDemoConflictError(
        "外部动作回读未命中预期状态",
        "WORKFLOW_DEMO_EXTERNAL_READBACK_FAILED",
      );
    }
  }
  return {
    run: applied.run,
    event: applied.event,
    objects: objectsAfter,
    completed: false,
  };
}

async function resolveExternalStep(
  store: WorkflowDemoStore,
  manifest: DemoManifestRecord,
  runId: string,
  eventId: string,
): Promise<{ run: WorkflowDemoRunRecord; step: DemoExecutionStep; publicEvent: DemoManifestRecord["public"]["timeline"][number] }> {
  const existing = (await store.readEvents(runId)).find((event) => event.eventId === eventId && event.source === "external");
  if (!existing) return resolveNextStep(store, manifest, runId, eventId);
  const step = manifest.internal.executionPlan?.find((item) => item.eventId === eventId);
  const publicEvent = manifest.public.timeline.find((item) => item.id === eventId);
  if (!step || !publicEvent) throw new WorkflowDemoStoreError("外部事件不在冻结计划中", "WORKFLOW_DEMO_EVENT_NOT_FOUND", 404);
  return { run: await requireRun(store, runId), step, publicEvent };
}

async function resolveNextStep(
  store: WorkflowDemoStore,
  manifest: DemoManifestRecord,
  runId: string,
  eventId: string,
): Promise<{ run: WorkflowDemoRunRecord; step: DemoExecutionStep; publicEvent: DemoManifestRecord["public"]["timeline"][number] }> {
  const run = await requireRun(store, runId);
  const events = await store.readEvents(runId);
  const plan = manifest.internal.executionPlan!;
  const next = plan[events.length];
  if (!next) {
    throw new WorkflowDemoConflictError("演示运行已没有待执行步骤", "WORKFLOW_DEMO_PLAN_COMPLETE");
  }
  if (next.eventId !== eventId) {
    throw new WorkflowDemoConflictError(
      `当前应执行步骤 ${next.eventId}`,
      "WORKFLOW_DEMO_STEP_ORDER_CONFLICT",
    );
  }
  const publicEvent = manifest.public.timeline.find((item) => item.id === next.eventId);
  if (!publicEvent) {
    throw new WorkflowDemoStoreError("公开时间线缺少执行步骤", "WORKFLOW_DEMO_EVENT_DEFINITION_MISSING", 409);
  }
  return { run, step: next, publicEvent };
}

async function resolveAgentStep(
  store: WorkflowDemoStore,
  manifest: DemoManifestRecord,
  runId: string,
  eventId: string,
): Promise<{
  run: WorkflowDemoRunRecord;
  step: DemoExecutionStep;
  publicEvent: DemoManifestRecord["public"]["timeline"][number];
  recoverCompletion: boolean;
  existingEvent?: WorkflowDemoEventRecord;
}> {
  const run = await requireRun(store, runId);
  const events = await store.readEvents(runId);
  const plan = manifest.internal.executionPlan!;
  if (events.length === plan.length && (run.status === "running" || run.status === "passed")) {
    const finalStep = plan.at(-1);
    const finalEvent = events.at(-1);
    const publicEvent = manifest.public.timeline.find((item) => item.id === eventId);
    if (finalStep?.phase === "verify"
      && finalStep.eventId === eventId
      && finalEvent?.eventId === eventId
      && finalEvent.source === "agent"
      && finalEvent.agentProvenance
      && publicEvent) {
      return { run, step: finalStep, publicEvent, recoverCompletion: true, existingEvent: finalEvent };
    }
  }
  const resolved = await resolveNextStep(store, manifest, runId, eventId);
  return { ...resolved, recoverCompletion: false };
}

async function completeVerifiedRun(
  store: WorkflowDemoStore,
  manifest: DemoManifestRecord,
  run: WorkflowDemoRunRecord,
  provenance: WorkflowDemoAgentProvenance,
): Promise<{ run: WorkflowDemoRunRecord; replayId: string }> {
  const [objects, events, mutations, waits] = await Promise.all([
    store.readObjectsAuthorized(run.runId, provenance),
    store.readEvents(run.runId),
    store.readMutations(run.runId),
    store.readWaits(run.runId),
  ]);
  assertRuntimeTypeEvidence(manifest, events, mutations, waits);
  const completedAt = events.at(-1)?.createdAt;
  if (!completedAt) {
    throw new WorkflowDemoConflictError(
      "最终事件缺少可复用的完成时间",
      "WORKFLOW_DEMO_TIMELINE_INCOMPLETE",
    );
  }
  const replay: WorkflowDemoPublicReplay = {
    replayVersion: 1,
    status: "passed",
    startedAt: run.startedAt,
    completedAt,
    ...projectManifestEvidence(manifest, events),
    verification: {
      readBackVerified: true,
      beforeObjectCount: manifest.public.before.length,
      afterObjectCount: objects.length,
      eventCount: events.length,
      receiptCount: new Set([
        ...events.map((event) => event.receiptId),
        ...mutations.map((mutation) => mutation.receiptId),
      ]).size,
      verifiedAt: completedAt,
      evidenceHash: digestCanonical({
        before: manifest.public.before,
        events: events.map(projectInternalEvidenceEvent),
        mutations,
        waits,
        after: objects,
      }),
    },
  };
  const completed = await store.completeRun(run.runId, provenance, replay);
  return { run: completed.run, replayId: completed.snapshot.replayId };
}

function projectManifestEvidence(
  manifest: DemoManifestRecord,
  events: WorkflowDemoEventRecord[],
): DemoPublicEvidence {
  const publicById = new Map(manifest.public.timeline.map((item) => [item.id, item]));
  return demoPublicEvidenceSchema.parse({
    id: manifest.id,
    workflowId: manifest.workflowId,
    catalogScenarioId: manifest.catalogScenarioId,
    primaryType: manifest.primaryType,
    environment: manifest.environment,
    title: manifest.public.title,
    environmentLabel: manifest.public.environmentLabel,
    before: manifest.public.before,
    timeline: events.map((event) => {
      const definition = publicById.get(event.eventId);
      if (!definition) throw new Error(`运行事件 ${event.eventId} 不在公开时间线中`);
      return {
        id: definition.id,
        label: definition.label,
        summary: definition.summary,
        state: event.state,
      };
    }),
    after: manifest.public.after,
    evidence: manifest.public.evidence,
  });
}

function validateManifestForExecution(manifest: DemoManifestRecord): DemoExecutionStep[] {
  if (manifest.environment.kind !== "isolated_stateful") {
    throw new WorkflowDemoStoreError("当前 Demo 适配器只允许隔离状态化环境", "WORKFLOW_DEMO_NOT_STATEFUL", 409);
  }
  const plan = manifest.internal.executionPlan;
  if (
    manifest.public.before.length === 0
    || manifest.public.after.length === 0
    || manifest.public.timeline.length === 0
    || manifest.public.evidence.length === 0
    || !plan
    || plan.length !== manifest.public.timeline.length
  ) {
    throw new WorkflowDemoStoreError("Demo 尚未具备可执行定义", "WORKFLOW_DEMO_NOT_READY", 409);
  }
  const objectIds = new Set(manifest.public.before.map((item) => item.id));
  for (const step of plan) {
    if (!objectIds.has(step.targetObjectId)) {
      throw new WorkflowDemoStoreError(`步骤 ${step.eventId} 引用了不存在的业务对象`, "WORKFLOW_DEMO_TARGET_NOT_FOUND", 409);
    }
    if (step.mutation && (!step.operationRef || !step.idempotencyRef)) {
      throw new WorkflowDemoStoreError(`写步骤 ${step.eventId} 缺动作或幂等绑定`, "WORKFLOW_DEMO_ACTION_BINDING_MISSING", 409);
    }
    if (step.mutation
      && step.phase !== "approval"
      && step.phase !== "resume"
      && (!step.workflowActionId
        || !step.permissionRef
        || !step.receiptSchemaRef
        || !step.workflowIdempotencyPolicyRef)) {
      throw new WorkflowDemoStoreError(
        `Agent 写步骤 ${step.eventId} 缺 canonical 动作、权限、回执或幂等策略绑定`,
        "WORKFLOW_DEMO_ACTION_BINDING_MISSING",
        409,
      );
    }
    for (const change of step.externalChanges ?? []) {
      if (!objectIds.has(change.targetObjectId)) {
        throw new WorkflowDemoStoreError(`步骤 ${step.eventId} 引用了不存在的外部变更对象`, "WORKFLOW_DEMO_TARGET_NOT_FOUND", 409);
      }
    }
  }
  if (plan.at(-1)?.phase !== "verify") {
    throw new WorkflowDemoStoreError("Demo 最后一步必须重新读取并验证终态", "WORKFLOW_DEMO_VERIFY_REQUIRED", 409);
  }
  return plan;
}

function assertRunMatchesManifest(run: WorkflowDemoRunRecord, manifest: DemoManifestRecord): void {
  if (
    run.demoId !== manifest.id
    || run.workflowId !== manifest.workflowId
    || run.catalogScenarioId !== manifest.catalogScenarioId
    || run.definitionVersion !== String(manifest.definitionVersion)
    || run.manifestDigest !== digestCanonical(manifest)
  ) {
    throw new WorkflowDemoConflictError("运行与当前 Demo 定义不一致", "WORKFLOW_DEMO_DEFINITION_CONFLICT");
  }
}

function assertRuntimeTypeEvidence(
  manifest: DemoManifestRecord,
  events: WorkflowDemoEventRecord[],
  mutations: WorkflowDemoMutationRecord[],
  waits: WorkflowDemoWaitRecord[],
): void {
  const plan = manifest.internal.executionPlan!;
  if (events.length !== plan.length || events.at(-1)?.phase !== "verify") {
    throw new WorkflowDemoConflictError("执行时间线尚未完整结束", "WORKFLOW_DEMO_TIMELINE_INCOMPLETE");
  }
  if (manifest.primaryType === "WATCH") {
    const observations = events.filter((event) => (
      event.phase === "observe"
      && event.readBackVerified
      && event.cycleId
      && event.observationKind
      && event.observedAt
      && event.sourceSnapshotDigest
    ));
    const cycles = new Set(observations.map((event) => event.cycleId));
    const kinds = new Set(observations.map((event) => event.observationKind));
    const plannedObservationIds = plan.filter((step) => step.phase === "observe").map((step) => step.eventId);
    const observedEventIds = new Set(observations.map((event) => event.eventId));
    if (
      cycles.size < 2
      || !kinds.has("normal")
      || !kinds.has("exception")
      || plannedObservationIds.some((eventId) => !observedEventIds.has(eventId))
    ) {
      throw new WorkflowDemoConflictError("WATCH 缺少正常/异常双周期证据", "WORKFLOW_DEMO_WATCH_EVIDENCE_MISSING");
    }
  }
  if (manifest.primaryType === "ACT" && !mutations.some((mutation) => mutation.source === "agent")) {
    throw new WorkflowDemoConflictError("ACT 缺少真实写入回执", "WORKFLOW_DEMO_ACT_RECEIPT_MISSING");
  }
  if (
    manifest.primaryType === "ACT"
    && !mutations.some((mutation) => mutation.source === "agent" && mutation.workflowActionId)
  ) {
    throw new WorkflowDemoConflictError("ACT 缺少冻结 Workflow 动作回执", "WORKFLOW_DEMO_ACT_BINDING_MISSING");
  }
  if (manifest.primaryType === "LOOP") {
    if (
      waits.length === 0
      || waits.some((wait) => wait.status !== "resumed" || !wait.resumedByUserId)
      || !events.some((event) => event.phase === "resume" && event.source === "external")
    ) {
      throw new WorkflowDemoConflictError("LOOP 缺少外部信号恢复证据", "WORKFLOW_DEMO_LOOP_RESUME_MISSING");
    }
  }
  if (
    manifest.primaryType === "CREATE"
    && (
      !manifest.public.evidence.some((item) => item.kind === "artifact")
      || !mutations.some((mutation) => mutation.source === "agent" && mutation.workflowActionId)
    )
  ) {
    throw new WorkflowDemoConflictError("CREATE 缺少可读取成果证据", "WORKFLOW_DEMO_CREATE_ARTIFACT_MISSING");
  }
}

function eventInput(
  runId: string,
  manifest: DemoManifestRecord,
  step: DemoExecutionStep,
  publicEvent: DemoManifestRecord["public"]["timeline"][number],
  readBackVerified: boolean,
  observation?: {
    cycleId: string;
    observationKind: "normal" | "exception";
    observedAt: string;
    sourceSnapshotDigest: string;
  },
) {
  return {
    eventId: step.eventId,
    phase: step.phase,
    label: publicEvent.label,
    summary: publicEvent.summary,
    state: step.expectedState,
    actorRole: step.actorRole,
    targetObjectId: step.targetObjectId,
    mutation: step.mutation,
    approvalRequired: step.approvalRequired,
    approvalEventRef: step.approvalEventRef ?? null,
    idempotencyKeyHash: hashWorkflowDemoIdempotencyKey(
      `${runId}:${step.idempotencyRef ?? step.resumeSignalRef ?? step.eventId}`,
    ),
    readBackVerified,
    receiptId: deterministicId("event", runId, step.eventId),
    ...observation,
  };
}

function buildObservationEvidence(
  step: DemoExecutionStep,
  objects: WorkflowDemoObjectState[],
): {
  cycleId: string;
  observationKind: "normal" | "exception";
  observedAt: string;
  sourceSnapshotDigest: string;
} {
  const target = objects.find((object) => object.id === step.targetObjectId);
  if (!step.cycleId || !step.observationKind || !target) {
    throw new WorkflowDemoStoreError("观察步骤缺少可验证来源快照", "WORKFLOW_DEMO_OBSERVATION_EVIDENCE_MISSING", 409);
  }
  return {
    cycleId: step.cycleId,
    observationKind: step.observationKind,
    observedAt: new Date().toISOString(),
    sourceSnapshotDigest: digestCanonical(target),
  };
}

function projectActionBinding(step: DemoExecutionStep) {
  return {
    eventId: step.eventId,
    phase: step.phase,
    targetObjectId: step.targetObjectId,
    mutation: step.mutation,
    approvalRequired: step.approvalRequired,
    workflowActionId: step.workflowActionId ?? null,
    operationRef: step.operationRef ?? null,
    permissionRef: step.permissionRef ?? null,
    approvalPolicyRef: step.approvalPolicyRef ?? null,
    receiptSchemaRef: step.receiptSchemaRef ?? null,
    workflowIdempotencyPolicyRef: step.workflowIdempotencyPolicyRef ?? null,
    idempotencyRef: step.idempotencyRef ?? null,
    expectedState: step.expectedState,
    externalChanges: step.externalChanges ?? [],
  };
}

function projectInternalEvidenceEvent(event: WorkflowDemoEventRecord) {
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    eventDigest: event.eventDigest,
    phase: event.phase,
    state: event.state,
    source: event.source,
    receiptId: event.receiptId,
    readBackVerified: event.readBackVerified,
    cycleId: event.cycleId ?? null,
    observationKind: event.observationKind ?? null,
    observedAt: event.observedAt ?? null,
    sourceSnapshotDigest: event.sourceSnapshotDigest ?? null,
    agentProvenanceDigest: event.agentProvenance ? digestCanonical(event.agentProvenance) : null,
    createdAt: event.createdAt,
  };
}

function assertReadBack(
  expected: Array<{ id: string; label: string; state: string }>,
  actual: WorkflowDemoObjectState[],
): void {
  const comparable = (items: Array<{ id: string; label: string; state: string }>) => items
    .map(({ id, label, state }) => ({ id, label, state }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (JSON.stringify(comparable(expected)) !== JSON.stringify(comparable(actual))) {
    throw new WorkflowDemoConflictError(
      "动作后的业务对象回读与目标终态不一致",
      "WORKFLOW_DEMO_FINAL_READBACK_FAILED",
    );
  }
}

function assertTargetReadBack(step: DemoExecutionStep, objects: WorkflowDemoObjectState[]): void {
  const target = objects.find((object) => object.id === step.targetObjectId);
  if (!target || target.state !== step.expectedState) {
    throw new WorkflowDemoConflictError(
      `步骤 ${step.eventId} 的独立回读未命中预期状态`,
      "WORKFLOW_DEMO_STEP_READBACK_FAILED",
    );
  }
}

async function requireRun(store: WorkflowDemoStore, runId: string): Promise<WorkflowDemoRunRecord> {
  const run = await store.getByRunId(runId);
  if (!run) throw new WorkflowDemoStoreError("Workflow Demo run 不存在", "WORKFLOW_DEMO_RUN_NOT_FOUND", 404);
  return run;
}

function deterministicId(kind: string, runId: string, eventId: string): string {
  return `${kind}-${createHash("sha256").update(`${runId}:${eventId}:${kind}`).digest("hex").slice(0, 32)}`;
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item ?? null)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
