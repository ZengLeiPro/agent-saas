import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MessageItem } from "@agent/shared";

import { TodoPanel } from "./TodoPanel";

function todoMessage(): MessageItem {
  return {
    id: "todo-1",
    type: "tool_use",
    toolName: "TodoWrite",
    toolId: "tool-1",
    toolInput: JSON.stringify({
      todos: [
        { content: "读取代码", status: "in_progress", activeForm: "正在读取代码" },
        { content: "修改展示", status: "pending" },
      ],
    }),
  };
}

describe("TodoPanel", () => {
  it("shows an active spinner while the run is active", () => {
    const { container } = render(<TodoPanel messages={[todoMessage()]} runActive />);

    expect(screen.getByText("正在读取代码")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("is narrower than and attached flush to the composer", () => {
    const { container } = render(<TodoPanel messages={[todoMessage()]} runActive />);
    const panel = container.firstElementChild;
    const panelSurface = panel?.firstElementChild;

    expect(panel?.classList.contains("mx-6")).toBe(true);
    expect(panel?.classList.contains("-mb-px")).toBe(true);
    expect(panelSurface?.classList.contains("rounded-t-lg")).toBe(true);
    expect(panelSurface?.classList.contains("rounded-b-none")).toBe(true);
  });

  it("points toward the action for the bottom-anchored panel", () => {
    render(<TodoPanel messages={[todoMessage()]} runActive />);

    const expandButton = screen.getByRole("button", { name: "展开任务清单" });
    const chevron = expandButton.lastElementChild;

    expect(chevron?.classList.contains("lucide-chevron-up")).toBe(true);
    expect(chevron?.classList.contains("rotate-180")).toBe(false);

    fireEvent.click(expandButton);

    expect(screen.getByRole("button", { name: "收起任务清单" })).toBeTruthy();
    expect(chevron?.classList.contains("rotate-180")).toBe(true);
  });

  it("keeps the latest todo snapshot static after the run stops", () => {
    const { container } = render(<TodoPanel messages={[todoMessage()]} runActive={false} />);

    expect(screen.getByText("停留在：读取代码")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("leaves business todos to the main conversation renderer", () => {
    const messages: MessageItem[] = [{
      id: "todo-business",
      type: "tool_use",
      toolName: "TodoWrite",
      toolId: "todo-business",
      toolInput: JSON.stringify({
        todos: [{
          id: "verify-order",
          kind: "business",
          content: "核验订单",
          status: "in_progress",
        }],
      }),
    }];

    const { container } = render(<TodoPanel messages={messages} sessionId="business-session" runActive />);

    expect(container.firstElementChild).toBeNull();
  });
});
