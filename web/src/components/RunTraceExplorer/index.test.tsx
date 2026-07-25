/**
 * RunTraceExplorer 的两条动线契约（S5-B）：
 *
 * 1. **列表压窄常驻，而不是隐藏**。改造前 `index.tsx:43` 用 `hidden` 把列表藏起来，
 *    下钻后完全看不到自己在哪一条、也看不到下一条。现在窄栏常驻 + 选中行高亮，
 *    同时保住原有优点：列表组件**始终挂载**（筛选与滚动状态不丢），不是销毁重建。
 * 2. **子 agent 下钻**。`subagent_started/finished` 后端一直在写、UI 从来没渲染。
 *    现在能点进子 run 自己的时间线，路径以面包屑呈现，逐层返回。
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RunTraceExplorer } from "./index";
import type { RunEventsResponse, TraceEvent } from "./types";

const runEvents = vi.fn();
const runsQuery = vi.fn();

vi.mock("./api", () => ({
  runTraceApi: {
    runEvents: (...args: unknown[]) => runEvents(...args),
  },
}));

vi.mock("@/components/PlatformAdmin/api", () => ({
  platformAdminApi: {
    runs: (...args: unknown[]) => runsQuery(...args),
    search: vi.fn().mockResolvedValue({ matches: [] }),
    sessionDetail: vi.fn().mockResolvedValue({ runs: [] }),
    users: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  },
}));

vi.mock("@/components/TenantManager/hooks", () => ({
  useTenants: () => ({ tenants: [{ id: "kaiyan", name: "开沿科技" }] }),
}));

vi.mock("@/components/TenantAnalytics/hooks", () => ({
  useModelDisplayMap: () => ({ labelFor: (value: string) => value }),
}));

const START = "2026-07-25T10:00:00.000Z";

function runRow(runId: string) {
  return {
    runId,
    sessionId: `sess-${runId}`,
    tenantId: "kaiyan",
    userId: "u1",
    username: "leo",
    realName: "曾磊",
    status: "completed",
    statusReason: null,
    model: "gpt-5.5",
    channel: "web",
    requestedAt: START,
    startedAt: START,
    completedAt: "2026-07-25T10:00:10.000Z",
    failedAt: null,
    cancelledAt: null,
  };
}

function eventsResponse(runId: string, events: TraceEvent[]): RunEventsResponse {
  return {
    runId,
    sessionId: `sess-${runId}`,
    run: {
      status: "completed",
      statusReason: null,
      model: "gpt-5.5",
      channel: "web",
      tenantId: "kaiyan",
      userId: "u1",
      requestedAt: START,
      startedAt: START,
      completedAt: "2026-07-25T10:00:10.000Z",
      failedAt: null,
      cancelledAt: null,
      executionTarget: "server-container",
      workspaceId: "ws-1",
      cumulativeInputTokens: 10,
    },
    billing: {
      totalCostYuan: 0,
      requestCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      models: [],
      requests: [],
    },
    events,
  };
}

const PARENT_EVENTS: TraceEvent[] = [
  {
    id: "p1",
    type: "assistant_tool_calls",
    timestamp: START,
    toolCalls: [{ id: "call-agent", name: "Agent", arguments: "{}" }],
  },
  {
    id: "p2",
    type: "subagent_started",
    timestamp: START,
    toolCallId: "call-agent",
    agentType: "explore",
    description: "查竞品定价",
    childSessionId: "sess-run-child",
    childRunId: "run-child",
  },
  {
    id: "p3",
    type: "subagent_finished",
    timestamp: "2026-07-25T10:00:04.000Z",
    toolCallId: "call-agent",
    agentType: "explore",
    childSessionId: "sess-run-child",
    childRunId: "run-child",
    status: "completed",
    durationMs: 4000,
    totalTokens: 500,
    toolUseCount: 3,
    turnCount: 2,
  },
];

const CHILD_EVENTS: TraceEvent[] = [
  { id: "c1", type: "user_message", timestamp: START, content: "子 agent 的委派 prompt" },
];

describe("RunTraceExplorer 列表与详情同屏", () => {
  beforeEach(() => {
    runEvents.mockReset();
    runsQuery.mockReset();
    window.history.replaceState({}, "", "/platform-admin/runs");
    runsQuery.mockResolvedValue({ items: [runRow("run-parent"), runRow("run-other")] });
    runEvents.mockImplementation((runId: string) => Promise.resolve(
      eventsResponse(runId, runId === "run-child" ? CHILD_EVENTS : PARENT_EVENTS),
    ));
  });

  it("打开详情后列表仍在 DOM 里且不被 hidden，选中行标记 aria-selected", async () => {
    render(<RunTraceExplorer />);

    const table = await screen.findByRole("table");
    const parentRow = within(table).getByText("run-parent").closest("tr");
    expect(parentRow).toBeTruthy();
    await userEvent.click(parentRow as HTMLElement);

    await waitFor(() => expect(screen.getByText("事件时间线", { exact: false })).toBeTruthy());
    // 列表没有被卸载，也没有 hidden（压窄常驻）
    const listTable = screen.getByRole("table");
    expect(listTable.closest("[aria-hidden='true']")).toBeNull();
    const selected = listTable.querySelector("tr[aria-selected='true']");
    expect(selected).toBeTruthy();
    expect(selected?.getAttribute("data-state")).toBe("selected");
    // 窄栏下收起「组织 / 用户」等宽列，只留状态 / 记录 / 耗时 / 开始
    expect(within(listTable).queryByText("组织 / 用户")).toBeNull();
    expect(within(listTable).getByText("状态")).toBeTruthy();
    expect(screen.getByRole("button", { name: /展开列表/ })).toBeTruthy();
  });

  it("点子 agent 下钻打开子 run 的时间线，面包屑逐层可返回", async () => {
    render(<RunTraceExplorer />);

    const table = await screen.findByRole("table");
    await userEvent.click(within(table).getByText("run-parent").closest("tr") as HTMLElement);
    await waitFor(() => expect(screen.getByText("子 agent · 搜索侦察")).toBeTruthy());

    await userEvent.click(screen.getAllByRole("button", { name: /查看子 agent 时间线/ })[0]!);

    // 子 run 的时间线被拉取，面包屑给出「父执行记录 → 子 agent」路径
    await waitFor(() => expect(runEvents).toHaveBeenCalledWith("run-child", {}));
    const crumbs = screen.getByLabelText("子 agent 下钻路径");
    expect(crumbs.textContent).toContain("父执行记录");
    expect(crumbs.textContent).toContain("子 agent · 搜索侦察：查竞品定价");
    await waitFor(() => expect(screen.getByText("子 agent 的委派 prompt")).toBeTruthy());

    // 返回上一层回到父 run，面包屑消失
    await userEvent.click(screen.getByRole("button", { name: "返回上一层" }));
    await waitFor(() => expect(screen.queryByLabelText("子 agent 下钻路径")).toBeNull());
    expect(screen.getByRole("button", { name: "返回列表" })).toBeTruthy();
  });

  it("面包屑的父级可点：直接从子 agent 跳回父 run", async () => {
    render(<RunTraceExplorer />);

    const table = await screen.findByRole("table");
    await userEvent.click(within(table).getByText("run-parent").closest("tr") as HTMLElement);
    await waitFor(() => expect(screen.getByText("子 agent · 搜索侦察")).toBeTruthy());
    await userEvent.click(screen.getAllByRole("button", { name: /查看子 agent 时间线/ })[0]!);
    await waitFor(() => expect(screen.getByLabelText("子 agent 下钻路径")).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: /父执行记录/ }));
    await waitFor(() => expect(screen.queryByLabelText("子 agent 下钻路径")).toBeNull());
  });

  it("「展开列表」关掉详情，完整筛选器回来", async () => {
    render(<RunTraceExplorer />);

    const table = await screen.findByRole("table");
    await userEvent.click(within(table).getByText("run-parent").closest("tr") as HTMLElement);
    await waitFor(() => expect(screen.getByRole("button", { name: /展开列表/ })).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: /展开列表/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /展开列表/ })).toBeNull());
    expect(screen.getByText("组织 / 用户")).toBeTruthy();
    expect(screen.getByPlaceholderText("搜索失败原因关键词")).toBeTruthy();
  });
});
