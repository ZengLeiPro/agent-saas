import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { resolve } from "node:path";

import type { DemoManifestRecord } from "../../../shared/src/index.js";
import {
  WorkflowDemoToolProvider,
  type WorkflowDemoStepInput,
} from "../agent/workflowDemoToolProvider.js";
import type { ToolCallContext } from "../agent/toolRuntime.js";
import { loadWorkflowLibraryV3 } from "../data/scenarios/workflowLibrary.js";
import { InMemoryWorkflowDemoStore } from "../data/workflowDemos/store.js";
import { createWorkflowDemosRouter } from "../routes/workflowDemos.js";
import { canonicalToolInputDigest } from "../runtime/rawAgentLoop.js";
import { InMemoryToolInvocationStore } from "../runtime/toolInvocationStore.js";

const STATEFUL_DEMO_ID = "demo-controlled-version-release-loop-v1";
const CATALOG_ID = "catalog-controlled-version-release-loop";
const DATA_PATH = resolve(import.meta.dirname, "../data/scenarios/workflow-library-v3.json");
const TEST_SIGNAL_SECRET = "workflow-demo-test-signal-secret-32-bytes-minimum";

describe("Workflow Demo routes", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryWorkflowDemoStore;
  let invocationStore: InMemoryToolInvocationStore;
  let manifest: DemoManifestRecord;
  let provider: WorkflowDemoToolProvider;
  let invocationSequence: number;
  let signalSequence: number;
  let continuationRequests: Array<{ runId: string; eventId: string; signalId: string }>;
  let continuationFailuresRemaining: number;
  let activeDispatch: { runId: string; eventId: string } | null;

  beforeEach(async () => {
    store = new InMemoryWorkflowDemoStore();
    invocationStore = new InMemoryToolInvocationStore();
    invocationSequence = 0;
    signalSequence = 0;
    continuationRequests = [];
    continuationFailuresRemaining = 0;
    activeDispatch = null;
    store.setRuntimeContinuationHandler(async (request) => {
      if (continuationFailuresRemaining > 0) {
        continuationFailuresRemaining -= 1;
        throw new Error("scheduler temporarily unavailable");
      }
      continuationRequests.push({
        runId: request.run.runId,
        eventId: request.nextEventId,
        signalId: request.externalSignalId,
      });
    });
    const loaded = await loadWorkflowLibraryV3(DATA_PATH);
    const resolvedManifest = loaded.internal.demos.find((item) => item.id === STATEFUL_DEMO_ID);
    if (!resolvedManifest) throw new Error("测试依赖的 V3 Demo 不存在");
    manifest = resolvedManifest;
    // 路由契约测试使用可执行隔离前态：observe 是只读断言，因此它的目标事实必须已存在，
    // 不能靠测试或 Engine 写入后再把它冒充为观察结果。
    const observeTargets = new Map(
      (manifest.internal.executionPlan ?? [])
        .filter((item) => item.phase === "observe")
        .map((item) => [item.targetObjectId, item.expectedState] as const),
    );
    manifest.public.before = manifest.public.before.map((item) => ({
      ...item,
      ...(observeTargets.has(item.id) ? { state: observeTargets.get(item.id)! } : {}),
    }));
    provider = new WorkflowDemoToolProvider({
      workflowDemoStore: store,
      toolInvocationStore: invocationStore,
      resolveManifest: async (demoId) => {
        if (demoId !== manifest.id) throw new Error(`未知 Demo: ${demoId}`);
        return manifest;
      },
      dispatch: () => activeDispatch,
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const actor = req.header("x-test-actor");
      if (actor === "user") {
        req.user = { sub: "user-a", username: "user-a", role: "user", tenantId: "tenant-a" };
      } else if (actor === "peer") {
        req.user = { sub: "user-peer", username: "user-peer", role: "user", tenantId: "tenant-a" };
      } else if (actor === "tenant-admin") {
        req.user = { sub: "admin-a", username: "admin-a", role: "admin", tenantId: "tenant-a" };
      } else if (actor === "tenant-admin-2") {
        req.user = { sub: "admin-a-2", username: "admin-a-2", role: "admin", tenantId: "tenant-a" };
      } else if (actor === "other") {
        req.user = { sub: "user-b", username: "user-b", role: "user", tenantId: "tenant-b" };
      } else if (actor === "platform-reviewer") {
        req.user = {
          sub: "platform-reviewer",
          username: "platform-reviewer",
          role: "admin",
          tenantId: "pantheon",
          platformCapabilities: ["workflow_demo.review"],
        };
      } else if (actor === "platform-publisher") {
        req.user = {
          sub: "platform-publisher",
          username: "platform-publisher",
          role: "admin",
          tenantId: "pantheon",
          platformCapabilities: ["workflow_demo.publish"],
        };
      }
      next();
    });
    app.use("/api", createWorkflowDemosRouter({
      store,
      signalChallengeSecret: TEST_SIGNAL_SECRET,
      v3Loader: async () => loaded,
    }));
    server = await new Promise((resolveServer) => {
      const listening = app.listen(0, "127.0.0.1", () => resolveServer(listening));
    });
    const address = server.address();
    baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  });

  afterEach(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it("启动不下发执行凭据，HTTP 旧写入口不可达，只有真实 Agent Tool provenance 能推进并完成", async () => {
    const unauthenticated = await fetch(
      `${baseUrl}/api/workflow-demos/${STATEFUL_DEMO_ID}/runs`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(unauthenticated.status).toBe(401);

    const missingKey = await start("user", undefined);
    expect(missingKey.response.status).toBe(400);
    expect(missingKey.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const key = "controlled-version-idempotency-001";
    const started = await start("user", key);
    expect(started.response.status).toBe(201);
    expect(started.body.run.status).toBe("running");
    expect(started.body.run.replay).toBeNull();
    expect(started.body).not.toHaveProperty("execution");
    expect(JSON.stringify(started.body)).not.toMatch(/executionToken|X-Workflow-Demo-Token/);
    expect(started.body.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "plm-revision", version: 1 }),
      expect.objectContaining({ id: "approval-checkpoint", version: 1 }),
    ]));
    const runId = started.body.run.runId as string;
    expect(started.body.dispatchMetadata).toEqual({
      workflowDemo: { runId, eventId: manifest.internal.executionPlan?.[0]?.eventId },
    });

    const repeated = await start("user", key);
    expect(repeated.response.status).toBe(200);
    expect(repeated.body.run.runId).toBe(runId);
    expect(repeated.body).not.toHaveProperty("execution");

    const fakeCredential = "A".repeat(48);
    const legacyStep = await fetch(`${baseUrl}/api/workflow-demos/runs/${runId}/steps`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-actor": "user",
        "X-Workflow-Demo-Token": fakeCredential,
      },
      body: JSON.stringify({ eventId: "detect-approved-revision" }),
    });
    const legacyRead = await fetch(`${baseUrl}/api/workflow-demos/runs/${runId}/adapter/objects`, {
      headers: { "x-test-actor": "user", "X-Workflow-Demo-Token": fakeCredential },
    });
    const legacyWrite = await fetch(`${baseUrl}/api/workflow-demos/runs/${runId}/adapter/objects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-actor": "user",
        "X-Workflow-Demo-Token": fakeCredential,
      },
      body: JSON.stringify({ objectId: "plm-revision", nextState: "伪造完成" }),
    });
    expect([legacyStep.status, legacyRead.status, legacyWrite.status]).toEqual([404, 404, 404]);
    expect(await store.readEvents(runId)).toEqual([]);
    expect(await store.readMutations(runId)).toEqual([]);

    const plan = manifest.internal.executionPlan!;
    for (const stepDefinition of plan.slice(0, 4)) {
      await agentStep(runId, stepDefinition.eventId);
    }
    expect((await store.readEvents(runId)).map((event) => event.eventId)).toEqual(
      plan.slice(0, 4).map((stepDefinition) => stepDefinition.eventId),
    );

    const approvalRequest = started.body.approvalRequests.find(
      (item: { eventId: string }) => item.eventId === "approve-release-digest",
    );
    expect(approvalRequest).toMatchObject({
      signalRef: "approval:approve-release-digest",
      approvalDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const legacySignal = await requestJson(
      `/api/workflow-demos/runs/${runId}/signals`,
      "tenant-admin",
      { method: "POST", body: { eventId: "approve-release-digest", signalDigest: approvalRequest.approvalDigest } },
    );
    expect(legacySignal.response.status).toBe(400);
    expect(legacySignal.body.code).toBe("INVALID_WORKFLOW_DEMO_SIGNAL");

    const peerApproval = await approvalSignal(runId, "peer", approvalRequest, approvalRequest.approvalDigest);
    expect(peerApproval.response.status).toBe(404);
    const creatorApproval = await approvalSignal(runId, "user", approvalRequest, approvalRequest.approvalDigest);
    expect(creatorApproval.response.status).toBe(404);
    const otherTenantApproval = await approvalSignal(runId, "other", approvalRequest, approvalRequest.approvalDigest);
    expect(otherTenantApproval.response.status).toBe(404);
    const actorBoundSignalId = "approval-actor-bound";
    const actorBoundChallenge = await requestJson(
      `/api/workflow-demos/runs/${runId}/signal-challenges`,
      "tenant-admin",
      { method: "POST", body: { eventId: approvalRequest.eventId, signalId: actorBoundSignalId } },
    );
    expect(actorBoundChallenge.response.status).toBe(200);
    const approvalStep = plan.find((item) => item.eventId === approvalRequest.eventId)!;
    const approvalTarget = (await store.readObjects(runId)).find((item) => item.id === approvalStep.targetObjectId)!;
    const stolenChallenge = await requestJson(
      `/api/workflow-demos/runs/${runId}/signals`,
      "tenant-admin-2",
      {
        method: "POST",
        body: {
          eventId: approvalRequest.eventId,
          challenge: actorBoundChallenge.body.challenge,
          signal: {
            signalId: actorBoundSignalId,
            signalRef: approvalRequest.signalRef,
            kind: "approval",
            occurredAt: new Date().toISOString(),
            approvalDigest: approvalRequest.approvalDigest,
            observations: [{
              objectId: approvalTarget.id,
              expectedVersion: approvalTarget.version,
              observedState: approvalStep.expectedState,
              sourceReceiptId: "stolen-challenge-receipt",
            }],
          },
        },
      },
    );
    expect(stolenChallenge.response.status).toBe(403);
    expect(stolenChallenge.body.code).toBe("WORKFLOW_DEMO_SIGNAL_CHALLENGE_INVALID");
    const wrongApproval = await approvalSignal(runId, "tenant-admin", approvalRequest, "0".repeat(64));
    expect(wrongApproval.response.status).toBe(409);
    expect(wrongApproval.body.code).toBe("WORKFLOW_DEMO_APPROVAL_DIGEST_MISMATCH");
    continuationFailuresRemaining = 1;
    const approval = await approvalSignal(
      runId,
      "tenant-admin",
      approvalRequest,
      approvalRequest.approvalDigest,
    );
    expect(approval.response.status).toBe(200);
    expect(approval.body.event.source).toBe("external");
    expect(approval.body.continuationQueued).toBe(false);
    expect(approval.body.continuationPending).toBe(true);
    expect(continuationRequests).toEqual([]);
    expect(await store.retryPendingRuntimeContinuations()).toBe(1);
    expect(continuationRequests).toEqual([{
      runId,
      eventId: plan[5]!.eventId,
      signalId: "approval-signal-5",
    }]);

    for (const stepDefinition of plan.slice(5)) {
      await agentStep(runId, stepDefinition.eventId);
    }
    const completed = await getRun(runId, "user");
    expect(completed.response.status).toBe(200);
    expect(completed.body.run.status).toBe("passed");
    expect(completed.body.run.replay.verification.readBackVerified).toBe(true);
    expect(completed.body.run.publicSharePath).toBeNull();
    expect((await store.readEvents(runId)).map((item) => item.source)).toEqual([
      "agent", "agent", "agent", "agent", "external",
      "agent", "agent", "agent", "agent", "agent", "agent", "agent",
    ]);
    expect(await store.readMutations(runId)).toHaveLength(9);
    expect(await invocationStore.listRunning()).toEqual([]);
  });

  it("未获得 Runtime stream 的本人启动可显式回收，已绑定真实会话后禁止伪装成启动失败", async () => {
    const abandoned = await start("user", "launch-abandon-idempotency-001");
    const abandonedRunId = abandoned.body.run.runId as string;
    const cancelled = await requestJson(
      `/api/workflow-demos/runs/${abandonedRunId}/launch`,
      "user",
      { method: "DELETE" },
    );
    expect(cancelled.response.status).toBe(200);
    expect(cancelled.body.status).toBe("failed");
    expect((await store.getByRunId(abandonedRunId))?.failureReason).toBe("launch_not_acknowledged");

    const bound = await start("user", "launch-bound-idempotency-001");
    const boundRunId = bound.body.run.runId as string;
    await agentStep(boundRunId, manifest.internal.executionPlan![0]!.eventId);
    const forbidden = await requestJson(
      `/api/workflow-demos/runs/${boundRunId}/launch`,
      "user",
      { method: "DELETE" },
    );
    expect(forbidden.response.status).toBe(409);
    expect(forbidden.body.code).toBe("WORKFLOW_DEMO_ALREADY_BOUND");
  });

  it("按 catalog id 启动默认演示且不暴露 internal demo/replay 字段", async () => {
    const started = await requestJson(
      `/api/workflow-demos/catalog/${CATALOG_ID}/runs`,
      "user",
      { method: "POST", body: {}, headers: { "Idempotency-Key": "catalog-start-001" } },
    );
    expect(started.response.status).toBe(201);
    expect(started.body.run).toMatchObject({
      workflowId: manifest.workflowId,
      catalogScenarioId: CATALOG_ID,
      status: "running",
    });
    expect(started.body.run).not.toHaveProperty("demoId");
    expect(started.body.run).not.toHaveProperty("replayId");
    expect(started.body.run).not.toHaveProperty("replay");
    expect(started.body.objects[0]).not.toHaveProperty("id");
    expect(started.body.dispatchMetadata.workflowDemo).toEqual({
      runId: started.body.run.runId,
      eventId: manifest.internal.executionPlan?.[0]?.eventId,
    });
  });

  it("运行者、独立复核者、独立发布者三身份分离，公开页仅暴露只读证据", async () => {
    const completed = await completeActRun("publish-chain-001");
    const runId = completed.runId;

    const earlyPublish = await publish(runId, "platform-publisher");
    expect(earlyPublish.response.status).toBe(409);
    expect(earlyPublish.body.code).toBe("WORKFLOW_DEMO_PUBLISH_REVIEW_REQUIRED");

    const deniedReview = await requestJson(
      `/api/workflow-demos/runs/${runId}/review-candidate`,
      "user",
    );
    expect(deniedReview.response.status).toBe(403);
    const candidate = await requestJson(
      `/api/workflow-demos/runs/${runId}/review-candidate`,
      "platform-reviewer",
    );
    expect(candidate.response.status).toBe(200);
    expect(candidate.body.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(candidate.body)).not.toContain("tenant-a");
    expect(JSON.stringify(candidate.body)).not.toContain("user-a");

    const review = await requestJson(
      `/api/workflow-demos/runs/${runId}/review`,
      "platform-reviewer",
      {
        method: "POST",
        body: { decision: "approved", contentHash: candidate.body.contentHash },
      },
    );
    expect(review.response.status).toBe(200);

    const actorPublish = await publish(runId, "user");
    expect(actorPublish.response.status).toBe(403);
    const reviewerPublish = await publish(runId, "platform-reviewer");
    expect(reviewerPublish.response.status).toBe(403);
    const published = await publish(runId, "platform-publisher");
    expect(published.response.status).toBe(200);
    expect(published.body.sharePath).toMatch(/^\/workflow-replays\/[a-f0-9-]{36}$/);
    expect(published.body.oneTimeTokenSharePath).toMatch(/^\/workflow-demo-share\/[A-Za-z0-9_-]{40,64}$/);

    for (const sharePath of [published.body.sharePath, published.body.oneTimeTokenSharePath]) {
      const apiPath = sharePath.startsWith("/workflow-replays/")
        ? sharePath.replace("/workflow-replays/", "/api/share/workflow-replays/")
        : sharePath.replace("/workflow-demo-share/", "/api/share/workflow-demos/");
      const response = await fetch(`${baseUrl}${apiPath}`);
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["assurance", "workflow"]);
      expect((body.assurance as { independentlyReviewed: boolean }).independentlyReviewed).toBe(true);
      const serialized = JSON.stringify(body);
      for (const forbidden of [
        "tenantId", "actorUserId", "recordedByUserId", "idempotencyKeyHash",
        "tenantRef", "accountRef", "businessObjectRefs", "executionToken",
        "runId", "eventId", "replayId", "contentHash", "evidenceDigest",
        "workflowActionId", "manifest", "mutation",
      ]) expect(serialized).not.toContain(forbidden);
    }

    const repeatedPublish = await publish(runId, "platform-publisher");
    expect(repeatedPublish.response.status).toBe(200);
    expect(repeatedPublish.body.oneTimeTokenSharePath).toBeNull();
    expect(repeatedPublish.body.sharePath).toBe(published.body.sharePath);

    const latest = await requestJson(
      `/api/workflow-demos/catalog/${CATALOG_ID}/latest`,
      "user",
    );
    expect(latest.response.status).toBe(200);
    expect(latest.body.sharePath).toBe(published.body.sharePath);
    expect(JSON.stringify(latest.body)).not.toContain("platform-publisher");
  });

  it("运行详情按租户和 owner 收口，复核入口单独授权", async () => {
    const started = await start("user", "owner-scope-001");
    const runId = started.body.run.runId as string;

    expect((await getRun(runId, "user")).response.status).toBe(200);
    expect((await getRun(runId, "tenant-admin")).response.status).toBe(200);
    expect((await getRun(runId, "peer")).response.status).toBe(404);
    expect((await getRun(runId, "other")).response.status).toBe(404);
    expect((await getRun(runId, "platform-reviewer")).response.status).toBe(404);
    expect((await requestJson(
      `/api/workflow-demos/runs/${runId}/review-candidate`,
      "tenant-admin",
    )).response.status).toBe(403);
  });

  it("不存在的 Demo、运行、公开 token 和未发布 replay 均返回 404", async () => {
    const missingDemo = await requestJson(
      "/api/workflow-demos/demo-not-found/runs",
      "user",
      { method: "POST", body: {}, headers: { "Idempotency-Key": "missing-demo-001" } },
    );
    expect(missingDemo.response.status).toBe(404);
    const missingId = "00000000-0000-4000-8000-000000000000";
    expect((await getRun(missingId, "user")).response.status).toBe(404);
    expect((await fetch(`${baseUrl}/api/share/workflow-demos/${"A".repeat(43)}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/share/workflow-replays/${missingId}`)).status).toBe(404);
  });

  async function completeActRun(key: string): Promise<{ runId: string }> {
    const started = await start("user", key);
    expect(started.response.status).toBe(201);
    const runId = started.body.run.runId as string;
    const approvalRequests = new Map<string, ApprovalRequest>(
      started.body.approvalRequests.map((item: ApprovalRequest) => [item.eventId, item]),
    );
    for (const stepDefinition of manifest.internal.executionPlan ?? []) {
      if (stepDefinition.phase === "approval") {
        const request = approvalRequests.get(stepDefinition.eventId);
        if (!request) throw new Error(`缺少批准请求: ${stepDefinition.eventId}`);
        const signaled = await approvalSignal(
          runId,
          "tenant-admin",
          request,
          request.approvalDigest,
        );
        expect(signaled.response.status).toBe(200);
      } else {
        await agentStep(runId, stepDefinition.eventId);
      }
    }
    const completed = await store.getByRunId(runId);
    expect(completed?.status).toBe("passed");
    return { runId };
  }

  async function agentStep(runId: string, eventId: string): Promise<Record<string, unknown>> {
    const stepDefinition = manifest.internal.executionPlan?.find((item) => item.eventId === eventId);
    if (!stepDefinition) throw new Error(`未知测试步骤: ${eventId}`);
    const objects = await store.readObjects(runId);
    const target = objects.find((item) => item.id === stepDefinition.targetObjectId);
    const input: WorkflowDemoStepInput = {
      workflowRunId: runId,
      eventId,
      ...(stepDefinition.mutation && target ? { expectedVersion: target.version } : {}),
    };
    activeDispatch = { runId, eventId };
    invocationSequence += 1;
    const runtimeRunId = `agent-runtime-run-${invocationSequence}`;
    const toolCallId = `workflow-demo-tool-${invocationSequence}`;
    const invocationId = `${runtimeRunId}:${toolCallId}`;
    await invocationStore.start({
      invocationId,
      runId: runtimeRunId,
      sessionId: "agent-session-user-a",
      toolCallId,
      toolName: "WorkflowDemoStep",
      executionTarget: "server-local",
      tenantId: "tenant-a",
      metadata: {
        toolId: "WorkflowDemoStep",
        toolInputDigest: canonicalToolInputDigest(input),
      },
    });
    const context: ToolCallContext = {
      channelContext: {
        channel: "web",
        user: { id: "user-a", username: "user-a", role: "user", tenantId: "tenant-a" },
      },
      workspace: { root: "/tmp/workflow-demo-route-test", executionTarget: "server-local" },
      sessionId: "agent-session-user-a",
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
      if (!result) throw new Error("WorkflowDemoStep 未被 Provider 接受");
      await invocationStore.complete(invocationId, "completed");
      return JSON.parse(result.content) as Record<string, unknown>;
    } catch (error) {
      await invocationStore.complete(invocationId, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  function start(actor: string, idempotencyKey: string | undefined) {
    return requestJson(
      `/api/workflow-demos/${STATEFUL_DEMO_ID}/runs`,
      actor,
      {
        method: "POST",
        body: {},
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
      },
    );
  }

  async function approvalSignal(
    runId: string,
    actor: string,
    request: ApprovalRequest,
    approvalDigest: string,
  ) {
    const stepDefinition = manifest.internal.executionPlan?.find((item) => item.eventId === request.eventId);
    if (!stepDefinition) throw new Error(`未知批准步骤: ${request.eventId}`);
    const target = (await store.readObjects(runId)).find((item) => item.id === stepDefinition.targetObjectId);
    if (!target) throw new Error(`批准目标不存在: ${stepDefinition.targetObjectId}`);
    signalSequence += 1;
    const signalId = `approval-signal-${signalSequence}`;
    const challenge = await requestJson(
      `/api/workflow-demos/runs/${runId}/signal-challenges`,
      actor,
      { method: "POST", body: { eventId: request.eventId, signalId } },
    );
    if (!challenge.response.ok) return challenge;
    return requestJson(
      `/api/workflow-demos/runs/${runId}/signals`,
      actor,
      {
        method: "POST",
        body: {
          eventId: request.eventId,
          challenge: challenge.body.challenge,
          signal: {
            signalId,
            signalRef: request.signalRef,
            kind: "approval",
            occurredAt: new Date().toISOString(),
            approvalDigest,
            observations: [{
              objectId: target.id,
              expectedVersion: target.version,
              observedState: stepDefinition.expectedState,
              sourceReceiptId: `approval-source-receipt-${signalSequence}`,
            }],
          },
        },
      },
    );
  }

  function publish(runId: string, actor: string) {
    return requestJson(
      `/api/workflow-demos/runs/${runId}/publish`,
      actor,
      { method: "POST", body: {} },
    );
  }

  function getRun(runId: string, actor: string) {
    return requestJson(`/api/workflow-demos/runs/${runId}`, actor);
  }

  async function requestJson(
    path: string,
    actor?: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ response: Response; body: any }> {
    const headers: Record<string, string> = {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(actor ? { "x-test-actor": actor } : {}),
      ...options.headers,
    };
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { response, body: await response.json() };
  }
});

interface ApprovalRequest {
  eventId: string;
  signalRef: string;
  approvalDigest: string;
  actionEventIds: string[];
}
