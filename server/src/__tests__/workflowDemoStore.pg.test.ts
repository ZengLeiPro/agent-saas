import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PgWorkflowDemoStore,
  type ApplyWorkflowDemoExternalSignalInput,
  type CreateWorkflowDemoRunInput,
  type WorkflowDemoAgentProvenance,
  type WorkflowDemoPublicReplay,
} from "../data/workflowDemos/store.js";
import {
  createWorkflowDemoPgHarness,
  type WorkflowDemoPgHarness,
  workflowDemoPgSuiteEnabled,
} from "./helpers/workflowDemoPgHarness.js";

const describePg = workflowDemoPgSuiteEnabled() ? describe : describe.skip;

describePg("Workflow Demo Store PostgreSQL 契约", () => {
  let harness: WorkflowDemoPgHarness;

  beforeAll(async () => {
    harness = await createWorkflowDemoPgHarness({ initialize: false });
    const peer = new PgWorkflowDemoStore({
      pool: harness.pool,
      tablePrefix: harness.prefix,
    });
    await Promise.all([harness.store.init(), peer.init()]);
  }, 30_000);

  afterAll(async () => {
    await harness.dispose();
  }, 30_000);

  it("并发 init 只建立一组完整表结构", async () => {
    const result = await harness.pool.query<{ tablename: string }>(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename = ANY($1::text[])
      ORDER BY tablename
    `, [harness.tables]);

    expect(result.rows.map((row) => row.tablename).sort())
      .toEqual([...harness.tables].sort());
  });

  it("服务重启后无需新 start 请求即可回收旧 launch，并允许同一幂等键重试", async () => {
    const beforeRestart = new PgWorkflowDemoStore({
      pool: harness.pool,
      tablePrefix: harness.prefix,
      unboundLaunchTtlMs: 20,
      unboundLaunchSweepIntervalMs: 60_000,
    });
    await beforeRestart.init();
    const input = createInput(`launch-restart-${randomUUID()}`);
    const first = await beforeRestart.getOrCreateRun(input);
    await harness.pool.query(
      `UPDATE ${harness.store.runsTable} SET started_at=now()-interval '1 hour' WHERE run_id=$1`,
      [first.run.runId],
    );
    await beforeRestart.close();

    const restarted = new PgWorkflowDemoStore({
      pool: harness.pool,
      tablePrefix: harness.prefix,
      unboundLaunchTtlMs: 20,
      unboundLaunchSweepIntervalMs: 10,
    });
    try {
      await restarted.init();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(await restarted.getByRunId(first.run.runId)).toMatchObject({
        status: "failed",
        failureReason: "launch_expired_before_runtime_ack",
      });

      const retried = await restarted.getOrCreateRun(input);
      expect(retried).toMatchObject({
        replayed: false,
        run: { runId: first.run.runId, status: "running" },
      });
      expect(retried.executionToken).toBeTypeOf("string");
      expect(retried.executionToken).not.toBe(first.executionToken);
    } finally {
      await restarted.close();
    }
  });

  it("真实 runtime session 绑定持久化且禁止跨会话重绑", async () => {
    const created = await createRun(harness, "runtime-session-binding");
    const bound = await harness.store.bindRuntimeSession(
      created.run.runId,
      provenance(created.input, "first-event"),
    );
    expect(bound.runtimeSessionId).toBe("session-one");
    const row = await harness.pool.query(
      `SELECT runtime_session_id FROM ${harness.store.runsTable} WHERE run_id=$1`,
      [created.run.runId],
    );
    expect(row.rows[0]?.runtime_session_id).toBe("session-one");

    await expect(harness.store.bindRuntimeSession(created.run.runId, {
      ...provenance(created.input, "first-event"),
      runtimeSessionId: "session-two",
    })).rejects.toMatchObject({ code: "WORKFLOW_DEMO_AGENT_PROVENANCE_INVALID" });
  });

  it("Agent provenance 与 token hash 写入 PostgreSQL，raw token 不落盘", async () => {
    const created = await createRun(harness, "provenance");
    await harness.store.seedObjects(created.run.runId, created.executionToken, [
      { id: "order-one", label: "订单", state: "待处理", version: 1 },
    ]);
    const actionDigest = "b".repeat(64);
    const mutationProvenance = provenance(created.input, "act-order", actionDigest);

    await harness.store.mutateObject(created.run.runId, mutationProvenance, {
      mutationId: "mutation-order",
      workflowActionId: "update-order",
      objectId: "order-one",
      expectedVersion: 1,
      nextState: "已处理",
      receiptId: "mutation-receipt-order",
      actionDigest,
    });
    const observationProvenance = provenance(created.input, "observe-order");
    await harness.store.appendEvent(created.run.runId, observationProvenance, {
      eventId: "observe-order",
      phase: "observe",
      label: "回读订单",
      summary: "从隔离业务系统重新读取订单",
      state: "已处理",
      actorRole: "workflow-agent",
      targetObjectId: "order-one",
      mutation: false,
      approvalRequired: false,
      idempotencyKeyHash: "event-observe-order",
      readBackVerified: true,
      receiptId: "event-receipt-observe-order",
      cycleId: "cycle-one",
      observationKind: "exception",
      observedAt: "2026-07-21T08:00:00.000Z",
      sourceSnapshotDigest: "c".repeat(64),
    });
    const waitProvenance = provenance(created.input, "wait-human");
    await harness.store.beginWait(created.run.runId, waitProvenance, {
      waitId: "wait-human",
      reason: "等待人工反馈",
      resumeConditionDigest: "resume-condition-one",
    });

    const [runRows, mutationRows, eventRows, waitRows] = await Promise.all([
      harness.pool.query(`SELECT execution_token_hash FROM ${harness.store.runsTable} WHERE run_id=$1`, [created.run.runId]),
      harness.pool.query(`SELECT agent_provenance FROM ${harness.store.mutationsTable} WHERE run_id=$1`, [created.run.runId]),
      harness.pool.query(`SELECT agent_provenance,cycle_id,observation_kind,observed_at,source_snapshot_digest FROM ${harness.store.eventsTable} WHERE run_id=$1`, [created.run.runId]),
      harness.pool.query(`SELECT agent_provenance FROM ${harness.store.waitsTable} WHERE run_id=$1`, [created.run.runId]),
    ]);

    expect(runRows.rows[0].execution_token_hash)
      .toBe(createHash("sha256").update(created.executionToken).digest("hex"));
    expect(JSON.stringify(runRows.rows[0])).not.toContain(created.executionToken);
    expect(mutationRows.rows[0].agent_provenance).toEqual(mutationProvenance);
    expect(eventRows.rows[0]).toMatchObject({
      agent_provenance: observationProvenance,
      cycle_id: "cycle-one",
      observation_kind: "exception",
      source_snapshot_digest: "c".repeat(64),
    });
    expect(new Date(eventRows.rows[0].observed_at).toISOString()).toBe("2026-07-21T08:00:00.000Z");
    expect(waitRows.rows[0].agent_provenance).toEqual(waitProvenance);

    const [mutations, events, waits] = await Promise.all([
      harness.store.readMutations(created.run.runId),
      harness.store.readEvents(created.run.runId),
      harness.store.readWaits(created.run.runId),
    ]);
    expect(mutations[0]).toMatchObject({
      source: "agent",
      recordedByUserId: created.input.actorUserId,
      workflowActionId: "update-order",
      agentProvenance: mutationProvenance,
    });
    expect(events[0]).toMatchObject({
      source: "agent",
      recordedByUserId: created.input.actorUserId,
      agentProvenance: observationProvenance,
      cycleId: "cycle-one",
      observationKind: "exception",
      sourceSnapshotDigest: "c".repeat(64),
    });
    expect(waits[0].agentProvenance).toEqual(waitProvenance);
  });

  it("多对象外部 signal 原子成功，并发重放只提交一次", async () => {
    const created = await createRun(harness, "external-success");
    await harness.store.seedObjects(created.run.runId, created.executionToken, [
      { id: "order-a", label: "订单 A", state: "待处理", version: 1 },
      { id: "order-b", label: "订单 B", state: "待处理", version: 1 },
    ]);
    await harness.store.beginWait(
      created.run.runId,
      provenance(created.input, "wait-success"),
      {
        waitId: "wait-success",
        reason: "等待独立角色确认",
        resumeConditionDigest: "resume-condition-success",
      },
    );
    const input = externalSignal(created.run.runId, {
      signalId: "signal-success",
      mutations: [
        mutation("mutation-a", "order-a", 1, "已确认", "receipt-a"),
        mutation("mutation-b", "order-b", 1, "已确认", "receipt-b"),
      ],
      wait: {
        waitId: "wait-success",
        expectedResumeConditionDigest: "resume-condition-success",
      },
    });

    const results = await Promise.all([
      harness.store.applyExternalSignal(input),
      harness.store.applyExternalSignal(input),
    ]);

    expect(results.map((item) => item.replayed).sort()).toEqual([false, true]);
    expect(results[0].objects).toEqual(results[1].objects);
    expect(await harness.store.readObjects(created.run.runId)).toMatchObject([
      { id: "order-a", state: "已确认", version: 2 },
      { id: "order-b", state: "已确认", version: 2 },
    ]);
    expect(await harness.store.readMutations(created.run.runId)).toHaveLength(2);
    expect(await harness.store.readWaits(created.run.runId)).toMatchObject([
      {
        waitId: "wait-success",
        status: "resumed",
        resumedByUserId: "external-reviewer",
        resumeEventDigest: "d".repeat(64),
      },
    ]);
    expect((await harness.store.getByRunId(created.run.runId))?.status).toBe("running");
    const events = await harness.store.readEvents(created.run.runId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "external",
      recordedByUserId: "external-reviewer",
      externalSignalId: "signal-success",
      externalTransactionDigest: "e".repeat(64),
      cycleId: "cycle-external",
      observationKind: "normal",
      sourceSnapshotDigest: "f".repeat(64),
    });

    await expect(harness.store.applyExternalSignal({
      ...input,
      transactionDigest: "d".repeat(64),
    })).rejects.toMatchObject({ code: "WORKFLOW_DEMO_EXTERNAL_SIGNAL_CONFLICT" });
    await expect(harness.store.applyExternalSignal({
      ...input,
      externalActorUserId: "another-reviewer",
    })).rejects.toMatchObject({ code: "WORKFLOW_DEMO_EXTERNAL_SIGNAL_CONFLICT" });
  });

  it("外部 signal 与 continuation outbox 同事务落库，调度首次失败后无需客户端重放即可恢复", async () => {
    const created = await createRun(harness, "continuation-outbox");
    const bound = await harness.store.bindRuntimeSession(
      created.run.runId,
      provenance(created.input, "bind-continuation"),
    );
    let failuresRemaining = 1;
    const delivered: string[] = [];
    harness.store.setRuntimeContinuationHandler(async (request) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("scheduler temporarily unavailable");
      }
      delivered.push(`${request.externalSignalId}:${request.nextEventId}`);
    });
    const input = externalSignal(created.run.runId, {
      signalId: "signal-continuation",
      continuation: {
        externalSignalId: "signal-continuation",
        nextEventId: "verify-after-resume",
      },
    });
    const applied = await harness.store.applyExternalSignal(input);

    const committed = await harness.pool.query(
      `SELECT status,attempts FROM ${harness.store.continuationsTable} WHERE run_id=$1`,
      [created.run.runId],
    );
    expect(committed.rows).toEqual([{ status: "pending", attempts: 0 }]);
    expect(await harness.store.readEvents(created.run.runId)).toHaveLength(1);

    expect(await harness.store.requestRuntimeContinuation({
      run: { ...applied.run, runtimeSessionId: bound.runtimeSessionId },
      externalEvent: applied.event,
      externalSignalId: "signal-continuation",
      nextEventId: "verify-after-resume",
    })).toBe(false);
    expect(delivered).toEqual([]);
    expect(await harness.store.retryPendingRuntimeContinuations()).toBe(1);
    expect(delivered).toEqual(["signal-continuation:verify-after-resume"]);
    const final = await harness.pool.query(
      `SELECT status,attempts,last_error,delivered_at IS NOT NULL AS delivered FROM ${harness.store.continuationsTable} WHERE run_id=$1`,
      [created.run.runId],
    );
    expect(final.rows).toEqual([{
      status: "delivered",
      attempts: 2,
      last_error: null,
      delivered: true,
    }]);
  });

  it("第二个对象 CAS 失败时回滚第一个对象、mutation 与 event", async () => {
    const created = await createRun(harness, "external-cas-rollback");
    await harness.store.seedObjects(created.run.runId, created.executionToken, [
      { id: "order-a", label: "订单 A", state: "待处理", version: 1 },
      { id: "order-b", label: "订单 B", state: "待处理", version: 1 },
    ]);
    const input = externalSignal(created.run.runId, {
      signalId: "signal-cas-rollback",
      mutations: [
        mutation("mutation-cas-a", "order-a", 1, "已确认", "receipt-cas-a"),
        mutation("mutation-cas-b", "order-b", 99, "已确认", "receipt-cas-b"),
      ],
    });

    await expect(harness.store.applyExternalSignal(input))
      .rejects.toMatchObject({ code: "WORKFLOW_DEMO_OBJECT_VERSION_CONFLICT" });

    expect(await harness.store.readObjects(created.run.runId)).toEqual([
      { id: "order-a", label: "订单 A", state: "待处理", version: 1 },
      { id: "order-b", label: "订单 B", state: "待处理", version: 1 },
    ]);
    expect(await harness.store.readMutations(created.run.runId)).toEqual([]);
    expect(await harness.store.readEvents(created.run.runId)).toEqual([]);

    const retried = await harness.store.applyExternalSignal({
      ...input,
      mutations: [
        input.mutations[0]!,
        { ...input.mutations[1]!, expectedVersion: 1 },
      ],
    });
    expect(retried.replayed).toBe(false);
    expect(await harness.store.readObjects(created.run.runId)).toMatchObject([
      { id: "order-a", state: "已确认", version: 2 },
      { id: "order-b", state: "已确认", version: 2 },
    ]);
  });

  it("第二个对象不存在时整个外部 signal 不产生任何副作用", async () => {
    const created = await createRun(harness, "external-missing-rollback");
    await harness.store.seedObjects(created.run.runId, created.executionToken, [
      { id: "order-a", label: "订单 A", state: "待处理", version: 1 },
    ]);
    const input = externalSignal(created.run.runId, {
      signalId: "signal-missing-rollback",
      mutations: [
        mutation("mutation-missing-a", "order-a", 1, "已确认", "receipt-missing-a"),
        mutation("mutation-missing-b", "order-missing", 1, "已确认", "receipt-missing-b"),
      ],
    });

    await expect(harness.store.applyExternalSignal(input))
      .rejects.toMatchObject({ code: "WORKFLOW_DEMO_OBJECT_NOT_FOUND" });
    expect(await harness.store.readObjects(created.run.runId)).toEqual([
      { id: "order-a", label: "订单 A", state: "待处理", version: 1 },
    ]);
    expect(await harness.store.readMutations(created.run.runId)).toEqual([]);
    expect(await harness.store.readEvents(created.run.runId)).toEqual([]);
  });

  it("外部 signal 的事件回执冲突会回滚对象、wait 与 run 状态", async () => {
    const created = await createRun(harness, "external-receipt-rollback");
    await harness.store.seedObjects(created.run.runId, created.executionToken, [
      { id: "case-one", label: "异常单", state: "待反馈", version: 1 },
    ]);
    const existingEventId = "existing-event";
    await harness.store.appendEvent(
      created.run.runId,
      provenance(created.input, existingEventId),
      event(existingEventId, "shared-event-receipt"),
    );
    await harness.store.beginWait(
      created.run.runId,
      provenance(created.input, "wait-external"),
      {
        waitId: "wait-external",
        reason: "等待外部确认",
        resumeConditionDigest: "resume-condition-external",
      },
    );
    const input = externalSignal(created.run.runId, {
      signalId: "signal-receipt-rollback",
      mutations: [mutation("mutation-receipt", "case-one", 1, "已确认", "mutation-receipt")],
      wait: {
        waitId: "wait-external",
        expectedResumeConditionDigest: "resume-condition-external",
      },
      eventReceiptId: "shared-event-receipt",
    });

    await expect(harness.store.applyExternalSignal(input))
      .rejects.toMatchObject({ code: "WORKFLOW_DEMO_RECEIPT_CONFLICT" });
    expect(await harness.store.readObjects(created.run.runId)).toEqual([
      { id: "case-one", label: "异常单", state: "待反馈", version: 1 },
    ]);
    expect(await harness.store.readMutations(created.run.runId)).toEqual([]);
    expect(await harness.store.readEvents(created.run.runId)).toHaveLength(1);
    expect(await harness.store.readWaits(created.run.runId)).toMatchObject([
      { waitId: "wait-external", status: "waiting" },
    ]);
    expect((await harness.store.getByRunId(created.run.runId))?.status).toBe("waiting");
  });

  it("replay_json 单边篡改后所有私有与公开读取均 fail-closed", async () => {
    const created = await createRun(harness, "replay-integrity");
    const completed = await harness.store.completeRun(
      created.run.runId,
      provenance(created.input, "complete-replay"),
      replay(created.input),
    );
    await harness.store.reviewReplay({
      runId: created.run.runId,
      reviewerUserId: "reviewer-two",
      decision: "approved",
      contentHash: completed.snapshot.contentHash,
    });
    const published = await harness.store.publishReplay({
      runId: created.run.runId,
      publisherUserId: "publisher-three",
    });
    const publicToken = published.publicToken!;

    await harness.pool.query(`
      UPDATE ${harness.store.replaysTable}
      SET replay_json = jsonb_set(replay_json, '{title}', to_jsonb('被单边篡改的标题'::text))
      WHERE run_id=$1
    `, [created.run.runId]);

    const reads = [
      () => harness.store.getReplayByRunId(created.run.runId),
      () => harness.store.getByPublicToken(publicToken),
      () => harness.store.getPublishedByReplayId(completed.snapshot.replayId),
      () => harness.store.getLatestPublishedByCatalog(created.input.catalogScenarioId),
    ];
    for (const read of reads) {
      await expect(read()).rejects.toMatchObject({
        code: "WORKFLOW_DEMO_REPLAY_INTEGRITY_FAILED",
        statusCode: 500,
      });
    }
  });
});

async function createRun(harness: WorkflowDemoPgHarness, label: string) {
  const suffix = `${label}-${randomUUID()}`;
  const input = createInput(suffix);
  const created = await harness.store.getOrCreateRun(input);
  expect(created.replayed).toBe(false);
  expect(created.executionToken).toBeTypeOf("string");
  return { input, run: created.run, executionToken: created.executionToken! };
}

function createInput(suffix: string): CreateWorkflowDemoRunInput {
  return {
    demoId: `demo-${suffix}`,
    workflowId: `workflow-${suffix}`,
    catalogScenarioId: `catalog-${suffix}`,
    tenantId: "tenant-one",
    actorUserId: "executor-one",
    idempotencyKey: `idem-${suffix}`,
    definitionVersion: "3.1.0",
    manifestDigest: "manifest-digest-one",
    actionDigest: "action-digest-one",
    approvalDigest: "approval-digest-one",
  };
}

function provenance(
  input: CreateWorkflowDemoRunInput,
  eventId: string,
  actionBindingDigest = "b".repeat(64),
): WorkflowDemoAgentProvenance {
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
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
  };
}

function mutation(
  mutationId: string,
  objectId: string,
  expectedVersion: number,
  nextState: string,
  receiptId: string,
) {
  return {
    mutationId,
    workflowActionId: `workflow-action-${mutationId}`,
    objectId,
    expectedVersion,
    nextState,
    receiptId,
    actionDigest: "b".repeat(64),
  };
}

function event(eventId: string, receiptId: string) {
  return {
    eventId,
    phase: "observe" as const,
    label: "读取状态",
    summary: "读取隔离系统的业务状态",
    state: "已读取",
    actorRole: "workflow-agent",
    targetObjectId: "case-one",
    mutation: false,
    approvalRequired: false,
    idempotencyKeyHash: `idempotency-${eventId}`,
    readBackVerified: true,
    receiptId,
  };
}

function externalSignal(
  runId: string,
  overrides: Partial<ApplyWorkflowDemoExternalSignalInput> & {
    eventReceiptId?: string;
  },
): ApplyWorkflowDemoExternalSignalInput {
  const {
    eventReceiptId = `event-receipt-${overrides.signalId ?? "external"}`,
    ...inputOverrides
  } = overrides;
  return {
    runId,
    externalActorUserId: "external-reviewer",
    signalId: "external-signal",
    signalDigest: "d".repeat(64),
    transactionDigest: "e".repeat(64),
    mutations: [],
    event: {
      eventId: `event-${overrides.signalId ?? "external"}`,
      phase: "resume",
      label: "接收外部信号",
      summary: "独立角色写入隔离业务系统状态",
      state: "已确认",
      actorRole: "external-reviewer",
      targetObjectId: "external-signal",
      mutation: true,
      approvalRequired: false,
      idempotencyKeyHash: `idempotency-${overrides.signalId ?? "external"}`,
      readBackVerified: true,
      receiptId: eventReceiptId,
      cycleId: "cycle-external",
      observationKind: "normal",
      observedAt: "2026-07-21T08:30:00.000Z",
      sourceSnapshotDigest: "f".repeat(64),
    },
    ...inputOverrides,
  };
}

function replay(input: CreateWorkflowDemoRunInput): WorkflowDemoPublicReplay {
  return {
    replayVersion: 1,
    status: "passed",
    startedAt: "2026-07-21T01:00:00.000Z",
    completedAt: "2026-07-21T01:05:00.000Z",
    id: input.demoId,
    workflowId: input.workflowId,
    catalogScenarioId: input.catalogScenarioId,
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
    evidence: [{ id: "receipt-one", kind: "receipt", label: "动作回执", summary: "隔离系统已返回持久化回执记录" }],
    verification: {
      readBackVerified: true,
      beforeObjectCount: 1,
      afterObjectCount: 1,
      eventCount: 2,
      receiptCount: 2,
      verifiedAt: "2026-07-21T01:05:00.000Z",
      evidenceHash: "a".repeat(64),
    },
  };
}
