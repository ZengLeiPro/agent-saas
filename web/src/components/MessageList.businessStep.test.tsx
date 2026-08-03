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
  it("renders plan, a completed section with collapsed process, and an open section", () => {
    render(<MessageList messages={messages()} loading={false} debugModeOverride={false} />);

    // 计划亮相块
    expect(screen.getByRole("region", { name: "业务计划" })).toBeTruthy();
    // 第 1 步：完成节——outcome 常显、过程折叠为一行
    expect(screen.getByRole("region", { name: "业务步骤已完成" })).toBeTruthy();
    expect(screen.getByText("17/18 张通过，1 张退回")).toBeTruthy();
    expect(screen.getByText("订单资料完整")).toBeTruthy();
    expect(screen.getByText(/过程 · 1 项/)).toBeTruthy();
    // 折叠态下工具活动不可见
    expect(screen.queryByText("读取订单")).toBeNull();
    // 第 2 步：开放节标题存在（plan 列表 + 节标题各一次）
    expect(screen.getAllByText("写入核验结果").length).toBeGreaterThanOrEqual(2);
    // TodoWrite 原始块隐藏
    expect(screen.queryByText("TodoWrite")).toBeNull();
  });

  it("re-expands the collapsed process on demand with full tool rendering", () => {
    render(<MessageList messages={messages()} loading={false} debugModeOverride={false} />);

    fireEvent.click(screen.getByText(/过程 · 1 项/));
    // 展开后节内是完整的活动组渲染（非降级视图）
    expect(screen.getByText(/读取订单/)).toBeTruthy();
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
