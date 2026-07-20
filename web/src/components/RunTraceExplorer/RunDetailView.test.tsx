import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runTraceApi } from "./api";
import { RunDetailView } from "./RunDetailView";
import type { RunEventsResponse } from "./types";

vi.mock("./api", () => ({
  runTraceApi: {
    runEvents: vi.fn(),
  },
}));

vi.mock("@/components/TenantAnalytics/hooks", () => ({
  useModelDisplayMap: () => ({ labelFor: (value: string) => value }),
}));

function response(status: string, statusReason: string | null): RunEventsResponse {
  const now = "2026-07-20T15:00:00.000Z";
  return {
    runId: `run-${status}`,
    sessionId: "session-1",
    run: {
      status,
      statusReason,
      model: "gpt-5.5",
      channel: "web",
      tenantId: "kaiyan",
      userId: "user-1",
      requestedAt: now,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      failedAt: status === "failed" ? now : null,
      cancelledAt: status === "cancelled" ? now : null,
      executionTarget: "server-container",
      workspaceId: "workspace-1",
      cumulativeInputTokens: 100,
    },
    billing: {
      totalCostYuan: 0,
      requestCount: 1,
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
      models: ["gpt-5.5"],
      requests: [],
    },
    events: [],
  };
}

describe("RunDetailView status notice", () => {
  beforeEach(() => {
    vi.mocked(runTraceApi.runEvents).mockReset();
  });

  it("does not render a failure alert for legacy completed runs with statusReason=success", async () => {
    vi.mocked(runTraceApi.runEvents).mockResolvedValue(response("completed", "success"));

    render(<RunDetailView runId="run-completed" onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("已完成")).toBeTruthy());
    expect(screen.queryByText(/失败原因：/)).toBeNull();
    expect(screen.queryByText("执行遇到技术错误")).toBeNull();
  });

  it("keeps a red failure alert for failed runs", async () => {
    vi.mocked(runTraceApi.runEvents).mockResolvedValue(response("failed", "model error"));

    render(<RunDetailView runId="run-failed" onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("失败原因：执行遇到技术错误")).toBeTruthy());
    expect(screen.getByText("model error")).toBeTruthy();
  });

  it("renders cancellation separately from failures", async () => {
    vi.mocked(runTraceApi.runEvents).mockResolvedValue(response("cancelled", "web_abort"));

    render(<RunDetailView runId="run-cancelled" onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("执行已取消")).toBeTruthy());
    expect(screen.queryByText(/失败原因：/)).toBeNull();
    expect(screen.getByText("web_abort")).toBeTruthy();
  });
});
