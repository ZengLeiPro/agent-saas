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
        todos: [{
          id: "verify-order",
          kind: "business",
          content: "核验订单",
          status: "in_progress",
        }],
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
        todos: [{
          id: "verify-order",
          kind: "business",
          content: "核验订单",
          status: "completed",
          detail: [{ verdict: "pass", text: "订单资料完整" }],
        }],
      }),
    },
  ];
}

describe("MessageList business todo projection", () => {
  it("renders one updated business card in the main conversation", () => {
    render(<MessageList messages={messages()} loading={false} debugModeOverride={false} />);

    expect(screen.getByRole("region", { name: "业务步骤" })).toBeTruthy();
    expect(screen.getByText("订单资料完整")).toBeTruthy();
    expect(screen.getByText("执行详情（1）")).toBeTruthy();
    expect(screen.queryByText("TodoWrite")).toBeNull();
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
