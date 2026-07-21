import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkflowReplayPage } from "./WorkflowReplayPage";

const { fetchPublicWorkflowReplay } = vi.hoisted(() => ({
  fetchPublicWorkflowReplay: vi.fn(),
}));

vi.mock("@/lib/workflowReplayApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/workflowReplayApi")>();
  return { ...original, fetchPublicWorkflowReplay };
});

describe("WorkflowReplayPage", () => {
  it("只展示业务前后状态、实际动作、人工点和复查证据", async () => {
    fetchPublicWorkflowReplay.mockResolvedValueOnce({
      workflow: {
        title: "受控版本发布",
        type: "会动系统",
        environment: {
          label: "隔离演示系统",
          data: "合成演示数据",
          limitation: "本页记录来自专用隔离演示系统，不代表已接入任何未配置的客户系统。",
        },
        before: [{ object: "受控版本", status: "等待批准" }],
        timeline: [{
          sequence: 1,
          event: "批准后发布并复查",
          action: "更新隔离业务系统后重新查询当前版本",
          result: "当前版本已生效",
          humanReview: true,
          followUp: true,
        }],
        after: [{ object: "受控版本", status: "已发布并复查确认" }],
        evidence: [{ category: "动作结果", evidence: "发布结果", conclusion: "写入后查询与批准版本一致" }],
      },
      assurance: {
        readBackVerified: true,
        independentlyReviewed: true,
        publishedAt: "2026-07-21T08:03:00.000Z",
        businessEventCount: 1,
        actionProofCount: 1,
        finalObjectCount: 1,
      },
    });

    render(<WorkflowReplayPage reference={{ kind: "replayId", value: "public-reference" }} />);

    expect(await screen.findByRole("heading", { name: "受控版本发布" })).toBeTruthy();
    expect(screen.getByText("处理前")).toBeTruthy();
    expect(screen.getByText("处理后")).toBeTruthy();
    expect(screen.getByText("批准后发布并复查")).toBeTruthy();
    expect(screen.getByText("需要人工确认")).toBeTruthy();
    expect(screen.getByText("会继续跟进")).toBeTruthy();
    expect(screen.getByText("独立复核通过")).toBeTruthy();
    expect(screen.getByText(/不代表已接入任何未配置的客户系统/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/回放 ID|内容指纹|runId|eventId|replayId|hash|digest|manifest|mutation|tenant|owner/i);
  });
});
