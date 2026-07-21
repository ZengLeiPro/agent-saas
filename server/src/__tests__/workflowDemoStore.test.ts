import { describe, expect, it } from "vitest";

import {
  InMemoryWorkflowDemoStore,
  type CreateWorkflowDemoRunInput,
  type WorkflowDemoPublicReplay,
  type WorkflowDemoAgentProvenance,
} from "../data/workflowDemos/store.js";

function createInput(overrides: Partial<CreateWorkflowDemoRunInput> = {}): CreateWorkflowDemoRunInput {
  return {
    demoId: "demo-one",
    workflowId: "workflow-one",
    catalogScenarioId: "catalog-one",
    tenantId: "tenant-one",
    actorUserId: "executor-one",
    idempotencyKey: "idem-key-one",
    definitionVersion: "3.1.0",
    manifestDigest: "manifest-digest-one",
    actionDigest: "action-digest-one",
    approvalDigest: "approval-digest-one",
    ...overrides,
  };
}

function provenance(eventId: string, actionBindingDigest = "b".repeat(64)): WorkflowDemoAgentProvenance {
  const runtimeRunId = `runtime-${eventId}`;
  const toolCallId = `call-${eventId}`;
  return {
    runtimeSessionId: "session-one",
    runtimeRunId,
    toolInvocationId: `${runtimeRunId}:${toolCallId}`,
    toolCallId,
    toolId: "WorkflowDemoStep",
    toolName: "WorkflowDemoStep",
    toolInputDigest: "a".repeat(64),
    workflowEventId: eventId,
    actionBindingDigest,
    tenantId: "tenant-one",
    actorUserId: "executor-one",
  };
}

function replay(overrides: Partial<WorkflowDemoPublicReplay> = {}): WorkflowDemoPublicReplay {
  return {
    replayVersion: 1,
    status: "passed",
    startedAt: "2026-07-21T01:00:00.000Z",
    completedAt: "2026-07-21T01:05:00.000Z",
    id: "demo-one",
    workflowId: "workflow-one",
    catalogScenarioId: "catalog-one",
    primaryType: "ACT",
    environment: { kind: "isolated_stateful", dataLabel: "synthetic" },
    title: "隔离演示",
    environmentLabel: "隔离演示系统·合成数据",
    before: [{ id: "order-one", label: "订单", state: "待处理" }],
    timeline: [
      { id: "event-one", label: "执行动作", summary: "写入隔离业务系统", state: "已处理" },
      { id: "event-two", label: "回读验证", summary: "重新查询业务对象", state: "已验证" },
    ],
    after: [{ id: "order-one", label: "订单", state: "已处理" }],
    evidence: [{ id: "receipt-one", kind: "receipt", label: "动作回执", summary: "隔离系统已返回不可变回执" }],
    verification: {
      readBackVerified: true,
      beforeObjectCount: 1,
      afterObjectCount: 1,
      eventCount: 2,
      receiptCount: 2,
      verifiedAt: "2026-07-21T01:05:00.000Z",
      evidenceHash: "a".repeat(64),
    },
    ...overrides,
  };
}

async function createdRun(store: InMemoryWorkflowDemoStore) {
  const created = await store.getOrCreateRun(createInput());
  expect(created.replayed).toBe(false);
  expect(created.executionToken).toBeTypeOf("string");
  return {
    run: created.run,
    executionToken: created.executionToken!,
  };
}

describe("Workflow Demo Store 安全与不可变契约", () => {
  it("未绑定启动无需后续请求即可自主过期，并允许同一幂等键安全重试", async () => {
    const store = new InMemoryWorkflowDemoStore({
      unboundLaunchTtlMs: 10,
      unboundLaunchSweepIntervalMs: 5,
    });
    try {
      const first = await store.getOrCreateRun(createInput());
      await new Promise((resolve) => setTimeout(resolve, 60));

      const expired = await store.getByRunId(first.run.runId);
      expect(expired).toMatchObject({
        status: "failed",
        failureReason: "launch_expired_before_runtime_ack",
      });

      const retried = await store.getOrCreateRun(createInput());
      expect(retried).toMatchObject({
        replayed: false,
        run: { runId: first.run.runId, status: "running" },
      });
      expect(retried.executionToken).toBeTypeOf("string");
      expect(retried.executionToken).not.toBe(first.executionToken);
      expect(retried.run.completedAt).toBeUndefined();
      expect(retried.run.failureReason).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("同一幂等键仅允许相同 canonical requestDigest", async () => {
    const store = new InMemoryWorkflowDemoStore();
    const first = await store.getOrCreateRun(createInput());
    const repeated = await store.getOrCreateRun(createInput());

    expect(repeated).toEqual({ run: first.run, replayed: true });
    expect(repeated.executionToken).toBeUndefined();
    await expect(store.getOrCreateRun(createInput({ actionDigest: "different-action" })))
      .rejects.toMatchObject({ code: "WORKFLOW_DEMO_IDEMPOTENCY_CONFLICT", statusCode: 409 });
    await expect(store.getOrCreateRun(createInput({
      demoId: "another-demo",
      workflowId: "another-workflow",
    }))).rejects.toMatchObject({ code: "WORKFLOW_DEMO_IDEMPOTENCY_CONFLICT", statusCode: 409 });
  });

  it("raw execution token 不进入 run DTO 或内存持久记录", async () => {
    const store = new InMemoryWorkflowDemoStore();
    const created = await store.getOrCreateRun(createInput());
    const rawToken = created.executionToken!;

    expect(JSON.stringify(created.run)).not.toContain(rawToken);
    const internals = store as unknown as {
      runs: Map<string, { executionTokenHash: string; record: unknown }>;
    };
    const internal = [...internals.runs.values()][0]!;
    expect(JSON.stringify(internal)).not.toContain(rawToken);
    expect(internal.executionTokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("对象写入与事件回执按版本、mutationId 和 eventId 保持幂等不可变", async () => {
    const store = new InMemoryWorkflowDemoStore();
    const { run, executionToken } = await createdRun(store);
    await store.seedObjects(run.runId, executionToken, [
      { id: "order-one", label: "订单", state: "待处理", version: 1 },
    ]);

    const mutationInput = {
      mutationId: "mutation-one",
      objectId: "order-one",
      expectedVersion: 1,
      nextState: "已处理",
      receiptId: "mutation-receipt-one",
      actionDigest: "b".repeat(64),
    };
    const mutationProvenance = provenance("event-one", mutationInput.actionDigest);
    const firstMutation = await store.mutateObject(run.runId, mutationProvenance, mutationInput);
    const repeatedMutation = await store.mutateObject(run.runId, mutationProvenance, mutationInput);
    expect(firstMutation.replayed).toBe(false);
    expect(repeatedMutation).toEqual({ mutation: firstMutation.mutation, replayed: true });
    await expect(store.mutateObject(run.runId, mutationProvenance, {
      ...mutationInput,
      nextState: "另一个状态",
    })).rejects.toMatchObject({ code: "WORKFLOW_DEMO_MUTATION_CONFLICT" });

    const eventInput = {
      eventId: "event-one",
      phase: "act" as const,
      label: "写入订单",
      summary: "隔离系统返回动作回执",
      state: "已处理",
      actorRole: "workflow-agent",
      targetObjectId: "order-one",
      mutation: true,
      approvalRequired: false,
      idempotencyKeyHash: "event-idempotency-hash",
      readBackVerified: false,
      receiptId: "event-receipt-one",
    };
    const eventProvenance = provenance("event-one", mutationInput.actionDigest);
    const firstEvent = await store.appendEvent(run.runId, eventProvenance, eventInput);
    const repeatedEvent = await store.appendEvent(run.runId, eventProvenance, eventInput);
    expect(firstEvent.event.sequence).toBe(1);
    expect(repeatedEvent).toEqual({ event: firstEvent.event, replayed: true });
    await expect(store.appendEvent(run.runId, eventProvenance, {
      ...eventInput,
      summary: "试图覆盖原事件",
    })).rejects.toMatchObject({ code: "WORKFLOW_DEMO_EVENT_CONFLICT" });
    await expect(store.appendEvent(run.runId, provenance("event-two", mutationInput.actionDigest), {
      ...eventInput,
      eventId: "event-two",
    })).rejects.toMatchObject({ code: "WORKFLOW_DEMO_RECEIPT_CONFLICT" });
  });

  it("wait 必须由匹配的独立事件恢复且不能跳过等待态", async () => {
    const store = new InMemoryWorkflowDemoStore();
    const { run, executionToken } = await createdRun(store);
    const waiting = await store.beginWait(run.runId, provenance("wait-human-feedback"), {
      waitId: "wait-human-feedback",
      reason: "等待负责人反馈",
      resumeConditionDigest: "feedback-condition-v1",
    });
    expect(waiting.status).toBe("waiting");
    expect((await store.getByRunId(run.runId))?.status).toBe("waiting");

    await expect(store.resumeRunBySignal(
      run.runId,
      "executor-one",
      waiting.waitId,
      "feedback-event-one",
    )).rejects.toMatchObject({ code: "WORKFLOW_DEMO_SELF_SIGNAL_FORBIDDEN", statusCode: 403 });

    const resumed = await store.resumeRunBySignal(
      run.runId,
      "reviewer-two",
      waiting.waitId,
      "feedback-event-one",
    );
    expect(resumed.status).toBe("resumed");
    expect(resumed.resumedByUserId).toBe("reviewer-two");
    expect((await store.getByRunId(run.runId))?.status).toBe("running");
    await expect(store.resumeRunBySignal(run.runId, "reviewer-two", waiting.waitId, "different-event"))
      .rejects.toMatchObject({ code: "WORKFLOW_DEMO_RESUME_CONFLICT" });
  });

  it("外部 signal 多对象写入全成或全不成，并支持端到端幂等重放", async () => {
    const store = new InMemoryWorkflowDemoStore();
    const { run, executionToken } = await createdRun(store);
    await store.seedObjects(run.runId, executionToken, [
      { id: "order-one", label: "订单", state: "待处理", version: 1 },
      { id: "stock-one", label: "库存", state: "待处理", version: 1 },
    ]);
    const base = {
      runId: run.runId,
      externalActorUserId: "reviewer-two",
      signalId: "approval-signal-one",
      signalDigest: "c".repeat(64),
      transactionDigest: "d".repeat(64),
      mutations: [
        { mutationId: "external-mutation-one", objectId: "order-one", expectedVersion: 1, nextState: "已批准", receiptId: "external-receipt-one", actionDigest: "e".repeat(64) },
        { mutationId: "external-mutation-two", objectId: "stock-one", expectedVersion: 1, nextState: "已锁定", receiptId: "external-receipt-two", actionDigest: "f".repeat(64) },
      ],
      event: {
        eventId: "approval-event-one",
        phase: "approval" as const,
        label: "独立批准",
        summary: "批准订单并锁定库存",
        state: "已批准",
        actorRole: "tenant-admin",
        targetObjectId: "order-one",
        mutation: false,
        approvalRequired: false,
        idempotencyKeyHash: "signal-idempotency",
        readBackVerified: true,
        receiptId: "external-event-receipt-one",
      },
    };
    const first = await store.applyExternalSignal(base);
    const repeated = await store.applyExternalSignal(base);
    expect(first.replayed).toBe(false);
    expect(repeated.replayed).toBe(true);
    expect(repeated.event).toEqual(first.event);
    expect(await store.readMutations(run.runId)).toHaveLength(2);
    expect((await store.readObjects(run.runId)).map((item) => [item.id, item.state, item.version])).toEqual([
      ["order-one", "已批准", 2],
      ["stock-one", "已锁定", 2],
    ]);
  });

  it("外部 signal 第二个对象 CAS 失败时第一对象也不落账", async () => {
    const store = new InMemoryWorkflowDemoStore();
    const { run, executionToken } = await createdRun(store);
    await store.seedObjects(run.runId, executionToken, [
      { id: "order-one", label: "订单", state: "待处理", version: 1 },
      { id: "stock-one", label: "库存", state: "待处理", version: 1 },
    ]);
    await expect(store.applyExternalSignal({
      runId: run.runId,
      externalActorUserId: "reviewer-two",
      signalId: "approval-signal-rollback",
      signalDigest: "1".repeat(64),
      transactionDigest: "2".repeat(64),
      mutations: [
        { mutationId: "rollback-one", objectId: "order-one", expectedVersion: 1, nextState: "已批准", receiptId: "rollback-receipt-one", actionDigest: "3".repeat(64) },
        { mutationId: "rollback-two", objectId: "stock-one", expectedVersion: 99, nextState: "已锁定", receiptId: "rollback-receipt-two", actionDigest: "4".repeat(64) },
      ],
      event: {
        eventId: "approval-event-rollback",
        phase: "approval",
        label: "独立批准",
        summary: "应整体回滚",
        state: "已批准",
        actorRole: "tenant-admin",
        targetObjectId: "order-one",
        mutation: false,
        approvalRequired: false,
        idempotencyKeyHash: "rollback-idempotency",
        readBackVerified: true,
        receiptId: "rollback-event-receipt",
      },
    })).rejects.toMatchObject({ code: "WORKFLOW_DEMO_OBJECT_VERSION_CONFLICT" });
    expect(await store.readMutations(run.runId)).toHaveLength(0);
    expect(await store.readEvents(run.runId)).toHaveLength(0);
    expect((await store.readObjects(run.runId)).map((item) => [item.id, item.state, item.version])).toEqual([
      ["order-one", "待处理", 1],
      ["stock-one", "待处理", 1],
    ]);
  });

  it("回放单独冻结；二次完成只能幂等读取，不能覆盖 passed 终态", async () => {
    const store = new InMemoryWorkflowDemoStore();
    const { run, executionToken } = await createdRun(store);
    const completeProvenance = provenance("event-two");
    const first = await store.completeRun(run.runId, completeProvenance, replay());
    const repeated = await store.completeRun(run.runId, completeProvenance, replay());

    expect(first.replayed).toBe(false);
    expect(repeated.replayed).toBe(true);
    expect(repeated.snapshot).toEqual(first.snapshot);
    expect((await store.getByRunId(run.runId))?.status).toBe("passed");
    await expect(store.completeRun(run.runId, completeProvenance, replay({
      title: "试图覆盖已冻结内容",
    }))).rejects.toMatchObject({ code: "WORKFLOW_DEMO_REPLAY_IMMUTABLE" });
    await expect(store.failRun(run.runId, executionToken, "试图覆盖 passed"))
      .rejects.toMatchObject({ code: "WORKFLOW_DEMO_TERMINAL_STATE_CONFLICT" });
  });

  it("执行者不能自审；公开 token 只返回一次且内存只保存 hash", async () => {
    const store = new InMemoryWorkflowDemoStore();
    const { run, executionToken } = await createdRun(store);
    const completed = await store.completeRun(run.runId, provenance("event-two"), replay());

    await expect(store.reviewReplay({
      runId: run.runId,
      reviewerUserId: "executor-one",
      decision: "approved",
      contentHash: completed.snapshot.contentHash,
    })).rejects.toMatchObject({ code: "WORKFLOW_DEMO_SELF_REVIEW_FORBIDDEN", statusCode: 403 });

    const review = await store.reviewReplay({
      runId: run.runId,
      reviewerUserId: "reviewer-two",
      decision: "approved",
      contentHash: completed.snapshot.contentHash,
    });
    expect(review).toMatchObject({
      reviewerUserId: "reviewer-two",
      contentHash: completed.snapshot.contentHash,
    });

    await expect(store.publishReplay({
      runId: run.runId,
      publisherUserId: "reviewer-two",
    })).rejects.toMatchObject({
      code: "WORKFLOW_DEMO_PUBLISH_SEPARATION_REQUIRED",
      statusCode: 403,
    });

    const firstPublish = await store.publishReplay({
      runId: run.runId,
      publisherUserId: "publisher-three",
    });
    const rawToken = firstPublish.publicToken!;
    expect(firstPublish.replayed).toBe(false);
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((await store.getByPublicToken(rawToken))?.snapshot.replayId)
      .toBe(completed.snapshot.replayId);

    const repeatedPublish = await store.publishReplay({
      runId: run.runId,
      publisherUserId: "publisher-three",
    });
    expect(repeatedPublish.replayed).toBe(true);
    expect(repeatedPublish.publicToken).toBeUndefined();
    const internals = store as unknown as {
      publications: Map<string, { publicTokenHash: string; record: unknown }>;
    };
    const publication = [...internals.publications.values()][0]!;
    expect(JSON.stringify(publication)).not.toContain(rawToken);
    expect(publication.publicTokenHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
