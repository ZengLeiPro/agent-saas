import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runTraceApi } from "./api";
import { RunDetailView } from "./RunDetailView";
import type { RunEventsResponse, TraceEvent } from "./types";

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

// ────────── S5-B ──────────

const START = "2026-07-20T15:00:00.000Z";

function withEvents(events: TraceEvent[], overrides: Partial<RunEventsResponse> = {}): RunEventsResponse {
  const base = response("completed", "success");
  return {
    ...base,
    run: { ...base.run, startedAt: START, requestedAt: START, completedAt: "2026-07-20T15:00:10.000Z" },
    events,
    ...overrides,
  };
}

function traceEvent(overrides: Partial<TraceEvent> & { id: string; type: string }): TraceEvent {
  return { timestamp: START, ...overrides };
}

describe("RunDetailView 时间线（S5-B）", () => {
  beforeEach(() => {
    vi.mocked(runTraceApi.runEvents).mockReset();
    window.history.replaceState({}, "", "/platform-admin/runs/run-completed");
  });

  it("事件时间显示为相对起点的偏移，并标注归一化口径", async () => {
    vi.mocked(runTraceApi.runEvents).mockResolvedValue(withEvents([
      traceEvent({ id: "e1", type: "user_message", content: "帮我查一下", timestamp: START }),
      traceEvent({ id: "e2", type: "assistant_message", content: "好的", timestamp: "2026-07-20T15:00:02.000Z" }),
    ]));

    render(<RunDetailView runId="run-completed" onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("+0.00s")).toBeTruthy());
    expect(screen.getByText("+2.00s")).toBeTruthy();
    expect(screen.getByText(/耗时条按本次运行总耗时归一化/)).toBeTruthy();
    // 图例：颜色编码必须有解释，否则运维只知道「有颜色」
    expect(screen.getByText("用户输入")).toBeTruthy();
    expect(screen.getByText("模型输出")).toBeTruthy();
  });

  it("工具调用仍按 toolCallId 聚合成行，tool_result / tool_audit 不再单独成节点", async () => {
    vi.mocked(runTraceApi.runEvents).mockResolvedValue(withEvents([
      traceEvent({
        id: "e1",
        type: "assistant_tool_calls",
        toolCalls: [{ id: "call-1", name: "Bash", arguments: "{\"command\":\"ls\"}" }],
      }),
      traceEvent({ id: "e2", type: "tool_result", toolCallId: "call-1", content: "a.txt" }),
      traceEvent({ id: "e3", type: "tool_audit", toolCallId: "call-1", status: "ok", durationMs: 4000, toolName: "Bash" }),
    ]));

    render(<RunDetailView runId="run-completed" onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("工具调用 × 1")).toBeTruthy());
    expect(screen.queryByText("工具结果")).toBeNull();
    expect(screen.queryByText("工具审计")).toBeNull();
    // 聚合行上带耗时条，按本次运行 10s 归一化 → 40%
    const bar = screen.getByRole("img", { name: /耗时 4\.0 秒/ });
    expect(bar.getAttribute("aria-label")).toContain("占本次运行总耗时 40%");
  });

  it("subagent_started / finished 合成一个子 agent 节点，并把子 run 交给下钻回调", async () => {
    const onDrillSubagent = vi.fn();
    vi.mocked(runTraceApi.runEvents).mockResolvedValue(withEvents([
      traceEvent({
        id: "e1",
        type: "assistant_tool_calls",
        toolCalls: [{ id: "call-agent", name: "Agent", arguments: "{}" }],
      }),
      traceEvent({
        id: "e2",
        type: "subagent_started",
        toolCallId: "call-agent",
        agentType: "general",
        description: "整理会议纪要",
        childSessionId: "sess-child",
        childRunId: "run-child",
      }),
      traceEvent({
        id: "e3",
        type: "subagent_finished",
        timestamp: "2026-07-20T15:00:06.000Z",
        toolCallId: "call-agent",
        agentType: "general",
        childSessionId: "sess-child",
        childRunId: "run-child",
        status: "completed",
        durationMs: 6000,
        totalTokens: 900,
        toolUseCount: 2,
        turnCount: 1,
      }),
    ]));

    render(<RunDetailView runId="run-completed" onBack={vi.fn()} onDrillSubagent={onDrillSubagent} />);

    await waitFor(() => expect(screen.getByText("子 agent · 通用执行")).toBeTruthy());
    // 成对合并：终态事件被吸收，不额外渲染第二个子 agent 节点
    expect(screen.getAllByText(/^子 agent · /).length).toBe(1);
    expect(screen.getByText("子 agent")).toBeTruthy();

    const drillButtons = screen.getAllByRole("button", { name: /查看子 agent 时间线/ });
    await userEvent.click(drillButtons[0]!);
    expect(onDrillSubagent).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-child", sessionId: "sess-child" }));
  });

  it("零事件走统一空态并给「重新加载」，不是一行死文本", async () => {
    vi.mocked(runTraceApi.runEvents).mockResolvedValue(withEvents([]));

    render(<RunDetailView runId="run-completed" onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("没有事件记录")).toBeTruthy());
    expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy();
  });

  it("拿不到详情时给出可操作空态，而不是整片白屏", async () => {
    vi.mocked(runTraceApi.runEvents).mockResolvedValue(null as unknown as RunEventsResponse);
    const onBack = vi.fn();

    render(<RunDetailView runId="run-missing" onBack={onBack} />);

    await waitFor(() => expect(screen.getByText("没有取到这次执行的详情")).toBeTruthy());
    await userEvent.click(screen.getAllByRole("button", { name: "返回列表" })[0]!);
    expect(onBack).toHaveBeenCalled();
  });

  it("下钻子 agent 后返回按钮语义变成「返回上一层」，并渲染面包屑", async () => {
    vi.mocked(runTraceApi.runEvents).mockResolvedValue(withEvents([]));

    render(
      <RunDetailView
        runId="run-child"
        onBack={vi.fn()}
        backLabel="返回上一层"
        breadcrumb={<nav aria-label="子 agent 下钻路径">父执行记录 run-parent</nav>}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "返回上一层" })).toBeTruthy());
    expect(screen.getByLabelText("子 agent 下钻路径")).toBeTruthy();
  });
});

describe("RunDetailView 查看同类失败（S5-B）", () => {
  beforeEach(() => {
    vi.mocked(runTraceApi.runEvents).mockReset();
    window.history.replaceState({}, "", "/platform-admin/runs/run-failed?tenantId=kaiyan&hours=1");
  });

  it("按提炼出的关键词跳执行记录列表，并预置失败状态与 7 天窗口", async () => {
    vi.mocked(runTraceApi.runEvents).mockResolvedValue(response("failed", "run timed out after 300000ms"));

    render(<RunDetailView runId="run-failed" onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/检索关键词：run timed out after/)).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /查看同类失败/ }));

    const params = new URLSearchParams(window.location.search);
    expect(window.location.pathname).toBe("/platform-admin/runs");
    expect(params.get("status")).toBe("failed");
    expect(params.get("reason")).toBe("run timed out after");
    expect(params.get("hours")).toBe("168");
  });

  it("成功的 run 不出现这个入口", async () => {
    vi.mocked(runTraceApi.runEvents).mockResolvedValue(response("completed", "success"));

    render(<RunDetailView runId="run-completed" onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("已完成")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /查看同类失败/ })).toBeNull();
  });
});
