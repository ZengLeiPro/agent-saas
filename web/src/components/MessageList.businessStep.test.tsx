import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MessageItem } from "@agent/shared";

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
  useAuth: () => ({ user: { id: "user-1", username: "tester", debugMode: false } }),
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

describe("MessageList business step sections", () => {
  it("renders plan, a compact completed section, and an open section", () => {
    render(<MessageList messages={messages()} loading={false} debugModeOverride={false} />);

    // 计划亮相块
    expect(screen.getByRole("region", { name: "业务计划" })).toBeTruthy();
    // 第 1 步：完成节只常显 outcome；业务详情可展开，内部过程不进入普通客户主流。
    expect(screen.getByRole("region", { name: "业务步骤已完成" })).toBeTruthy();
    expect(screen.getByText("17/18 张通过，1 张退回")).toBeTruthy();
    expect(screen.queryByText("订单资料完整")).toBeNull();
    expect(screen.queryByText(/过程 · 1 项/)).toBeNull();
    expect(screen.queryByText("读取订单")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "业务详情" }));
    expect(screen.getByText("订单资料完整")).toBeTruthy();
    // 第 2 步：开放节标题存在（plan 列表 + 节标题各一次）
    expect(screen.getAllByText("写入核验结果").length).toBeGreaterThanOrEqual(2);
    // TodoWrite 原始块隐藏
    expect(screen.queryByText("TodoWrite")).toBeNull();
  });

  it("hides completed execution-process metadata outside debug mode", () => {
    render(<MessageList messages={messages()} loading={false} debugModeOverride={false} />);

    expect(screen.queryByText(/过程 · 1 项/)).toBeNull();
    expect(screen.queryByText(/读取订单/)).toBeNull();
    expect(screen.getByRole("button", { name: "业务详情" })).toBeTruthy();
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

  it("keeps activity groups inside the expanded process in debug mode", () => {
    render(<MessageList messages={messages()} loading={false} debugModeOverride />);

    // debug 视图会额外保留 TodoWrite 原始工具块，因此过程项数包含该工具。
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
