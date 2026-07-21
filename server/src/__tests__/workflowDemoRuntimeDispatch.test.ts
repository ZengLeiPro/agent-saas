import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { DemoManifestRecord } from "../../../shared/src/index.js";
import { loadWorkflowLibraryV3 } from "../data/scenarios/workflowLibrary.js";
import { initializeWorkflowDemo } from "../data/workflowDemos/engine.js";
import { InMemoryWorkflowDemoStore } from "../data/workflowDemos/store.js";
import {
  HIDDEN_WORKFLOW_DEMO_CONTINUE_PROMPT,
  resolveWakePrompt,
  validateWorkflowDemoDispatchMetadata,
} from "../runtime/rawRuntimeRunDispatch.js";

const DATA_PATH = resolve(import.meta.dirname, "../data/scenarios/workflow-library-v3.json");
const DEMO_ID = "demo-controlled-version-release-loop-v1";

describe("Workflow Demo 真实会话调度元数据", () => {
  let manifest: DemoManifestRecord;
  let store: InMemoryWorkflowDemoStore;
  let runId: string;
  let firstEventId: string;

  beforeAll(async () => {
    const loaded = await loadWorkflowLibraryV3(DATA_PATH);
    const resolved = loaded.internal.demos.find((item) => item.id === DEMO_ID);
    if (!resolved) throw new Error(`缺少测试 Demo: ${DEMO_ID}`);
    manifest = resolved;
  });

  beforeEach(async () => {
    store = new InMemoryWorkflowDemoStore();
    const initialized = await initializeWorkflowDemo(store, {
      manifest,
      tenantId: "tenant-a",
      actorUserId: "user-a",
      idempotencyKey: `runtime-dispatch-${crypto.randomUUID()}`,
    });
    runId = initialized.run.runId;
    firstEventId = manifest.internal.executionPlan?.[0]?.eventId ?? "";
  });

  it("只接受同租户、同执行者、当前事件的隐藏元数据", async () => {
    await expect(validateWorkflowDemoDispatchMetadata({
      store,
      metadata: { workflowDemo: { runId, eventId: firstEventId } },
      sessionId: "session-a",
      tenantId: "tenant-a",
      actorUserId: "user-a",
    })).resolves.toEqual({ runId, eventId: firstEventId });

    await expect(validateWorkflowDemoDispatchMetadata({
      store,
      metadata: { workflowDemo: { runId, eventId: firstEventId } },
      sessionId: "session-a",
      tenantId: "tenant-b",
      actorUserId: "user-a",
    })).rejects.toThrow("身份与运行不一致");
    await expect(validateWorkflowDemoDispatchMetadata({
      store,
      metadata: { workflowDemo: { runId, eventId: "forged-event" } },
      sessionId: "session-a",
      tenantId: "tenant-a",
      actorUserId: "user-a",
    })).rejects.toThrow("当前步骤不匹配");
  });

  it("首次可信工具调用绑定会话后拒绝串到另一会话", async () => {
    await store.bindRuntimeSession(runId, {
      runtimeSessionId: "session-a",
      runtimeRunId: "runtime-run-a",
      toolInvocationId: "runtime-run-a:tool-call-a",
      toolCallId: "tool-call-a",
      toolId: "WorkflowDemoStep",
      toolName: "WorkflowDemoStep",
      toolInputDigest: "0".repeat(64),
      workflowEventId: firstEventId,
      actionBindingDigest: "1".repeat(64),
      tenantId: "tenant-a",
      actorUserId: "user-a",
    });
    await expect(validateWorkflowDemoDispatchMetadata({
      store,
      metadata: { workflowDemo: { runId, eventId: firstEventId } },
      sessionId: "session-b",
      tenantId: "tenant-a",
      actorUserId: "user-a",
    })).rejects.toThrow("已绑定其他 Agent 会话");
  });

  it("普通消息不激活 Demo，伪造格式 fail closed", async () => {
    await expect(validateWorkflowDemoDispatchMetadata({
      store,
      metadata: { hiddenContinuation: true },
      sessionId: "session-a",
      tenantId: "tenant-a",
      actorUserId: "user-a",
    })).resolves.toBeNull();
    await expect(validateWorkflowDemoDispatchMetadata({
      store,
      metadata: { workflowDemo: { runId: "not-a-uuid", eventId: firstEventId } },
      sessionId: "session-a",
      tenantId: "tenant-a",
      actorUserId: "user-a",
    })).rejects.toThrow("调度元数据无效");
  });

  it("外部信号续跑消息不冒充新的用户消息", () => {
    const decision = resolveWakePrompt({
      runId: "runtime-continuation",
      sessionId: "session-a",
      userId: "user-a",
      tenantId: "tenant-a",
      status: "pending",
      requestedAt: "2026-07-21T14:00:00.000Z",
      updatedAt: "2026-07-21T14:00:00.000Z",
      metadata: {
        wakeMessage: {
          content: HIDDEN_WORKFLOW_DEMO_CONTINUE_PROMPT,
          metadata: {
            hiddenContinuation: true,
            workflowDemo: { runId, eventId: firstEventId },
          },
        },
      },
    }, [], {
      sessionId: "session-a",
      userId: "user-a",
      username: "user-a",
      tenantId: "tenant-a",
      channel: "web",
      cwd: "/tmp/workflow-demo-runtime",
      transcriptPath: "/tmp/workflow-demo-runtime/transcript.jsonl",
      createdAt: "2026-07-21T14:00:00.000Z",
      updatedAt: "2026-07-21T14:00:00.000Z",
    });
    expect(decision.recordUserMessage).toBe(false);
    expect(decision.message.metadata).toMatchObject({
      hiddenContinuation: true,
      workflowDemo: { runId, eventId: firstEventId },
      schedulerWake: true,
    });
  });
});
