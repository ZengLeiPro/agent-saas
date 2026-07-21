import { afterEach, describe, expect, it, vi } from "vitest";
import { projectWorkflowDemoPublic } from "@agent/shared";

import { fetchPublicWorkflowReplay } from "./workflowReplayApi";

const response = {
  workflow: {
    title: "受控写入演示",
    type: "会动系统",
    environment: {
      label: "隔离演示系统",
      data: "合成演示数据",
      limitation: "本页记录来自专用隔离演示系统，不代表已接入任何未配置的客户系统。",
    },
    before: [{ object: "业务对象", status: "待处理" }],
    timeline: [{
      sequence: 1,
      event: "写入并回读",
      action: "在隔离系统更新状态后重新查询",
      result: "已完成",
      humanReview: true,
      followUp: false,
    }],
    after: [{ object: "业务对象", status: "已完成" }],
    evidence: [{ category: "动作结果", evidence: "业务写入结果", conclusion: "动作后重新读取一致" }],
  },
  assurance: {
    readBackVerified: true,
    independentlyReviewed: true,
    publishedAt: "2026-07-21T08:03:00.000Z",
    businessEventCount: 1,
    actionProofCount: 1,
    finalObjectCount: 1,
  },
};

afterEach(() => vi.restoreAllMocks());

describe("workflowReplayApi", () => {
  it("回放引用与一次性 token 分别请求公开 API 并做严格解析", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }));

    await expect(fetchPublicWorkflowReplay({ kind: "replayId", value: "00000000-0000-4000-8000-000000000001" }))
      .resolves.toEqual(response);
    await expect(fetchPublicWorkflowReplay({ kind: "token", value: "token value" }))
      .resolves.toEqual(response);

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/share/workflow-replays/00000000-0000-4000-8000-000000000001");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/api/share/workflow-demos/token%20value");
  });

  it("拒绝混入任何运行标识、hash 或内部字段的响应", async () => {
    for (const injected of [
      { replayId: "00000000-0000-4000-8000-000000000001" },
      { runId: "internal-run" },
      { eventId: "internal-event" },
      { contentHash: "a".repeat(64) },
      { manifest: { tenant: "secret" } },
    ]) {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
        ...response,
        ...injected,
      }), { status: 200 }));
      await expect(fetchPublicWorkflowReplay({ kind: "replayId", value: "public-reference" }))
        .rejects.toThrow("未通过公开数据校验");
    }
  });

  it("公开 DTO 叶子只包含业务对象、动作结果、人工点和复查信息", () => {
    const serialized = JSON.stringify(response);
    expect(serialized).not.toMatch(/runId|eventId|replayId|hash|digest|manifest|mutation|tenant|owner/i);
    expect(serialized).toContain("业务对象");
    expect(serialized).toContain("humanReview");
    expect(serialized).toContain("重新读取");
  });

  it("服务端公开投影剥离标识和校验指纹，并把内部状态转成业务表述", () => {
    const projected = projectWorkflowDemoPublic({
      replayId: "00000000-0000-4000-8000-000000000001",
      replay: {
        replayVersion: 1,
        status: "passed",
        startedAt: "2026-07-21T08:00:00.000Z",
        completedAt: "2026-07-21T08:01:00.000Z",
        id: "demo-one",
        workflowId: "workflow-one",
        catalogScenarioId: "catalog-one",
        primaryType: "LOOP",
        environment: { kind: "isolated_stateful", dataLabel: "synthetic" },
        title: "客户承诺闭环",
        environmentLabel: "隔离演示系统",
        before: [{ id: "object-one", label: "客户承诺", state: "WAITING_APPROVAL；owner=销售甲；eventId=EVT-01" }],
        timeline: [{
          id: "event-one",
          label: "批准后继续",
          summary: "Agent mutation 完成后保存 receipt，不把 manifest 当作证据。",
          state: "RESUMED_CUSTOMER_RESPONSE；workflowActionId=A-01；evidenceDigest=opaque",
        }],
        after: [{ id: "object-one", label: "客户承诺", state: "COMPLETED_VERIFIED；runId=RUN-01" }],
        evidence: [{
          id: "receipt-one",
          kind: "readback",
          label: "重新查询结果",
          summary: "状态已从业务系统重新读取。",
        }],
        verification: {
          readBackVerified: true,
          beforeObjectCount: 1,
          afterObjectCount: 1,
          eventCount: 1,
          receiptCount: 1,
          verifiedAt: "2026-07-21T08:01:00.000Z",
          evidenceHash: "a".repeat(64),
        },
      },
      integrity: {
        contentHash: "b".repeat(64),
        reviewedAt: "2026-07-21T08:02:00.000Z",
        publishedAt: "2026-07-21T08:03:00.000Z",
        independentlyReviewed: true,
      },
    });

    const serialized = JSON.stringify(projected);
    expect(serialized).not.toMatch(/runId|eventId|replayId|hash|digest|manifest|mutation|tenant|owner/i);
    expect(projected.workflow.before[0]?.status).toContain("等待");
    expect(projected.workflow.timeline[0]).toMatchObject({ humanReview: true, followUp: true });
  });
});
