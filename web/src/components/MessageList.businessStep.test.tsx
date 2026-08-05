import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageItem } from "@agent/shared";

const authState = vi.hoisted(() => ({ businessStepDisplayMode: "auto" }));

beforeAll(() => {
  // jsdom 未实现 Range.getClientRects（MessageItem footer 行内测量用）；
  // 返回空列表 → footer 走非行内分支，不影响本用例断言。
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;
});

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: {
      id: "user-1",
      username: "tester",
      debugMode: false,
      preferences: { businessStepDisplayMode: authState.businessStepDisplayMode },
    },
  }),
}));

vi.mock("@/hooks/useVoicePlayer", () => ({
  useVoicePlayer: () => ({
    activeId: null,
    getState: () => "idle",
    play: vi.fn(),
    togglePause: vi.fn(),
    stop: vi.fn(),
  }),
}));

import { MessageList } from "./MessageList";

beforeEach(() => {
  authState.businessStepDisplayMode = "auto";
});

function messages(): MessageItem[] {
  return [
    { id: "user-1", type: "user", content: "核验订单" },
    {
      id: "todo-start",
      type: "tool_use",
      toolName: "TodoWrite",
      toolId: "todo-start",
      toolInput: JSON.stringify({
        todos: [
          { id: "verify-order", kind: "business", content: "核验订单", status: "in_progress" },
          { id: "write-result", kind: "business", content: "写入核验结果", status: "pending" },
        ],
      }),
    },
    {
      id: "read-order",
      type: "tool_use",
      toolName: "Read",
      toolId: "read-order",
      toolInput: "{}",
      executionStatus: "completed",
      presentation: { title: "读取订单" },
    },
    {
      id: "todo-finish",
      type: "tool_use",
      toolName: "TodoWrite",
      toolId: "todo-finish",
      toolInput: JSON.stringify({
        todos: [
          {
            id: "verify-order",
            kind: "business",
            content: "核验订单",
            status: "completed",
            outcome: { text: "17/18 张通过，1 张退回", tone: "warn" },
            detail: [{ verdict: "pass", text: "订单资料完整" }],
          },
          { id: "write-result", kind: "business", content: "写入核验结果", status: "in_progress" },
        ],
      }),
    },
  ];
}

describe("MessageList first Agent row spacing", () => {
  it("gives the first Agent text line a 20px avatar gap", () => {
    const { container } = render(
      <MessageList
        messages={[
          { id: "user-1", type: "user", content: "开始" },
          { id: "agent-1", type: "text", content: "我先检查当前状态。" },
        ]}
        loading={false}
        debugModeOverride={false}
      />,
    );

    expect(container.firstElementChild?.className).toContain("chat-message-content");
    const spacingWrapper = screen.getByText("我先检查当前状态。").closest("div.pt-1\\.5");
    expect(spacingWrapper).toBeTruthy();
  });

  it("puts the first activity status line on the unified flow rhythm (no self margin)", () => {
    render(
      <MessageList
        messages={[
          { id: "user-1", type: "user", content: "开始" },
          {
            id: "tool-1",
            type: "tool_use",
            toolName: "Shell",
            toolId: "tool-1",
            toolInput: "{}",
            executionStatus: "completed",
            resultReady: true,
            result: "ok",
          },
        ]}
        loading={false}
        debugModeOverride={false}
      />,
    );

    // 统一节奏（2026-08-04）：壳无 mb-3，bubble 内容层用 flex gap-2.5 + pt-1.5 统一承担间距
    expect(screen.getByText("已运行").closest("div.mb-3")).toBeNull();
    const wrapper = screen.getByText("已运行").closest("div.gap-2\\.5");
    expect(wrapper?.className).toContain("pt-1.5");
  });

  it("gives the thinking placeholder the same unified header gap", () => {
    render(
      <MessageList
        messages={[{ id: "user-1", type: "user", content: "开始" }]}
        loading
        debugModeOverride={false}
      />,
    );

    expect(screen.getByText("正在思考").parentElement?.parentElement?.className).toContain("pt-1.5");
  });

  it("keeps the business plan on the same unified flow rhythm", () => {
    render(<MessageList messages={messages()} loading={false} debugModeOverride={false} />);

    const plan = screen.getByRole("region", { name: "业务计划" });
    expect(plan.parentElement?.className).toContain("gap-2.5");
    expect(plan.parentElement?.className).toContain("pt-1.5");
  });
});

describe("MessageList business step sections", () => {
  it("uses smart folding: completed sections collapse while the current section stays open", () => {
    render(<MessageList messages={messages()} loading={false} debugModeOverride={false} />);

    expect(screen.getByRole("region", { name: "业务计划" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "业务步骤已完成" })).toBeTruthy();
    const completedToggle = screen.getByRole("button", { name: /核验订单.*第 1\/2 步.*已完成/ });
    const currentToggle = screen.getByRole("button", { name: /写入核验结果.*第 2\/2 步/ });
    expect(completedToggle.getAttribute("aria-expanded")).toBe("false");
    expect(currentToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByText("17/18 张通过，1 张退回")).toBeNull();
    expect(screen.queryByText("订单资料完整")).toBeNull();
    expect(screen.queryByText(/过程 · 1 项/)).toBeNull();
    expect(screen.queryByText("读取订单")).toBeNull();
    expect(screen.queryByText("TodoWrite")).toBeNull();
  });

  it("reveals completed business details on title click without exposing debug metadata", () => {
    render(<MessageList messages={messages()} loading={false} debugModeOverride={false} />);

    fireEvent.click(screen.getByRole("button", { name: /核验订单.*已完成/ }));
    expect(screen.queryByText(/过程 · 1 项/)).toBeNull();
    expect(screen.queryByText(/读取订单/)).toBeNull();
    expect(screen.queryByRole("button", { name: "业务详情" })).toBeNull();
    expect(screen.getByText("订单资料完整")).toBeTruthy();
  });

  it("places the batch control beside 业务计划 and applies it to every step in that plan", () => {
    const withOpenActivity: MessageItem[] = [
      ...messages(),
      {
        id: "open-section-tool",
        type: "tool_use",
        toolName: "Shell",
        toolId: "open-section-tool",
        toolInput: "{}",
        executionStatus: "completed",
        resultReady: true,
        result: "ok",
      },
    ];
    render(<MessageList messages={withOpenActivity} loading={false} debugModeOverride={false} />);

    const planTitle = screen.getByText("业务计划");
    const collapseAll = screen.getByRole("button", { name: "全部收起" });
    expect(planTitle.nextElementSibling).toBe(collapseAll);
    expect(screen.getByText("已运行")).toBeTruthy();

    fireEvent.click(collapseAll);
    expect(screen.getByRole("button", { name: "全部展开" })).toBeTruthy();
    expect(screen.queryByText("已运行")).toBeNull();
    expect(screen.queryByText("订单资料完整")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "全部展开" }));
    expect(screen.getByText("已运行")).toBeTruthy();
    expect(screen.getByText("订单资料完整")).toBeTruthy();
  });

  it("keeps plan-level controls working when progress text splits the workflow into multiple AI bubbles", () => {
    const splitMessages = messages();
    splitMessages.splice(2, 0, { id: "progress", type: "text", content: "先同步一下当前进度。" });
    render(<MessageList messages={splitMessages} loading={false} debugModeOverride={false} />);

    fireEvent.click(screen.getByRole("button", { name: "全部收起" }));
    expect(screen.getByRole("button", { name: "全部展开" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全部展开" }));
    expect(screen.getByText("订单资料完整")).toBeTruthy();
  });

  it("honors always-collapsed and always-expanded personal preferences", () => {
    const withOpenActivity: MessageItem[] = [
      ...messages(),
      {
        id: "open-section-tool",
        type: "tool_use",
        toolName: "Shell",
        toolId: "open-section-tool",
        toolInput: "{}",
        executionStatus: "completed",
        resultReady: true,
        result: "ok",
      },
    ];

    authState.businessStepDisplayMode = "collapsed";
    const { unmount } = render(
      <MessageList messages={withOpenActivity} loading={false} debugModeOverride={false} />,
    );
    expect(screen.getByRole("button", { name: "全部展开" })).toBeTruthy();
    expect(screen.queryByText("已运行")).toBeNull();
    expect(screen.queryByText("订单资料完整")).toBeNull();
    unmount();

    authState.businessStepDisplayMode = "expanded";
    render(<MessageList messages={withOpenActivity} loading={false} debugModeOverride={false} />);
    expect(screen.getByRole("button", { name: "全部收起" })).toBeTruthy();
    expect(screen.getByText("已运行")).toBeTruthy();
    expect(screen.getByText("订单资料完整")).toBeTruthy();
  });

  it("renders activity groups inside open sections as static summaries outside debug mode", () => {
    const withOpenActivity: MessageItem[] = [
      ...messages(),
      {
        id: "open-section-tool",
        type: "tool_use",
        toolName: "Shell",
        toolId: "open-section-tool",
        toolInput: "{}",
        executionStatus: "completed",
        resultReady: true,
        result: "ok",
      },
    ];
    render(<MessageList messages={withOpenActivity} loading={false} debugModeOverride={false} />);

    const summary = screen.getByText("已运行");
    expect(summary.closest("button")).toBeNull();
    expect(summary.closest("[aria-expanded]")).toBeNull();
    expect(screen.queryByText("Shell")).toBeNull();
  });

  it("keeps activity group shells margin-free both inside sections and in flat flow", () => {
    // 统一节奏（2026-08-04 曾磊拍板）：无论节内还是扁平流，壳都不带流向 margin，
    // 块间距一律由容器 gap 承担——不再存在「轮内/轮间不同补偿」的分叉。
    const withOpenActivity: MessageItem[] = [
      ...messages(),
      {
        id: "open-section-tool",
        type: "tool_use",
        toolName: "Shell",
        toolId: "open-section-tool",
        toolInput: "{}",
        executionStatus: "completed",
        resultReady: true,
        result: "ok",
      },
    ];
    const { unmount } = render(
      <MessageList messages={withOpenActivity} loading={false} debugModeOverride={false} />,
    );
    const inSection = screen.getByText("已运行");
    expect(inSection.closest("div.mb-3")).toBeNull();
    expect(inSection.closest("div.gap-2\\.5")).toBeTruthy();
    unmount();

    const flatFlow: MessageItem[] = [
      { id: "user-1", type: "user", content: "查一下" },
      {
        id: "flat-tool",
        type: "tool_use",
        toolName: "Shell",
        toolId: "flat-tool",
        toolInput: "{}",
        executionStatus: "completed",
        resultReady: true,
        result: "ok",
      },
    ];
    render(<MessageList messages={flatFlow} loading={false} debugModeOverride={false} />);
    const inFlat = screen.getByText("已运行");
    expect(inFlat.closest("div.mb-3")).toBeNull();
    expect(inFlat.closest("div.gap-2\\.5")).toBeTruthy();
  });

  it("keeps activity groups inside the expanded process in debug mode", () => {
    render(<MessageList messages={messages()} loading={false} debugModeOverride />);

    // 先展开已完成步骤；debug 视图会额外保留 TodoWrite 原始工具块，因此过程项数包含该工具。
    fireEvent.click(screen.getByRole("button", { name: /核验订单.*已完成/ }));
    fireEvent.click(screen.getByRole("button", { name: /过程 · 2 项/ }));

    // 过程展开后先显示活动组摘要，而不是直接铺开组内命令。
    const groupToggle = screen.getByRole("button", { name: /读取订单.*2 项/ });
    expect(groupToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("TodoWrite")).toBeNull();

    // 继续展开活动组后，才显示具体命令。
    fireEvent.click(groupToggle);
    expect(screen.getByText("TodoWrite")).toBeTruthy();
    expect(screen.getAllByText(/读取订单/).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps final text outside any section", () => {
    const withSummary: MessageItem[] = [
      ...messages().slice(0, 2),
      {
        id: "todo-done",
        type: "tool_use",
        toolName: "TodoWrite",
        toolId: "todo-done",
        toolInput: JSON.stringify({
          todos: [
            { id: "verify-order", kind: "business", content: "核验订单", status: "completed" },
            { id: "write-result", kind: "business", content: "写入核验结果", status: "completed" },
          ],
        }),
      },
      { id: "final", type: "text", content: "任务全部完成，共处理 18 张订单。" },
    ];
    render(<MessageList messages={withSummary} loading={false} debugModeOverride={false} />);

    // 最终总结正文在所有节外正常渲染
    expect(screen.getByText(/任务全部完成/)).toBeTruthy();
  });

  it("keeps a 500-message conversation DOM bounded before viewport measurement", () => {
    const longMessages = Array.from({ length: 500 }, (_, index): MessageItem => ({
      id: `user-${index + 1}`,
      type: "user",
      content: `消息 ${index + 1}`,
      timestamp: index + 1,
    }));
    const { container } = render(
      <MessageList messages={longMessages} loading={false} debugModeOverride={false} />,
    );

    expect(container.querySelectorAll("[data-message-virtual-key]")).toHaveLength(80);
    expect(screen.getByText("消息 500")).toBeTruthy();
    expect(screen.queryByText("消息 1")).toBeNull();
  });
});
