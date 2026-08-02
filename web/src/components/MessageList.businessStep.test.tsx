import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MessageItem } from "@agent/shared";

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
            detail: [{ verdict: "pass", text: "订单资料完整" }],
          },
          { id: "write-result", kind: "business", content: "写入核验结果", status: "in_progress" },
        ],
      }),
    },
  ];
}

describe("MessageList business step timeline", () => {
  it("renders plan, terminal summary and start trace as a linear timeline", () => {
    render(<MessageList messages={messages()} loading={false} debugModeOverride={false} />);

    // 计划亮相块
    expect(screen.getByRole("region", { name: "业务计划" })).toBeTruthy();
    // 终态块携带业务小结
    expect(screen.getByRole("region", { name: "业务步骤已完成" })).toBeTruthy();
    expect(screen.getByText("订单资料完整")).toBeTruthy();
    // 第二步开始痕迹（plan 块 + start 行各出现一次）
    expect(screen.getAllByText("写入核验结果")).toHaveLength(2);
    // TodoWrite 原始块隐藏
    expect(screen.queryByText("TodoWrite")).toBeNull();
  });

  it("keeps ordinary tool activity in the flow instead of absorbing it into cards", () => {
    const { container } = render(
      <MessageList messages={messages()} loading={false} debugModeOverride={false} />,
    );

    // 普通工具调用保留在活动分组中（时间顺序），不被吸进任何步骤卡
    expect(screen.queryByText(/执行详情/)).toBeNull();
    expect(container.textContent).toContain("读取订单");
  });

  it("renders timeline order: plan before activity before terminal block", () => {
    const { container } = render(
      <MessageList messages={messages()} loading={false} debugModeOverride={false} />,
    );

    const html = container.innerHTML;
    const planPos = html.indexOf("业务计划");
    const completePos = html.indexOf("业务步骤已完成");
    expect(planPos).toBeGreaterThan(-1);
    expect(completePos).toBeGreaterThan(planPos);
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
