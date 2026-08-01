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

  it("renders a rich business step and groups its tool activity", () => {
    const messages: MessageItem[] = [
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
            activeForm: "正在核验订单",
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
        presentation: { title: "读取订单", status: "ok" },
      },
      {
        id: "todo-blocked",
        type: "tool_use",
        toolName: "TodoWrite",
        toolId: "todo-blocked",
        toolInput: JSON.stringify({
          todos: [{
            id: "verify-order",
            kind: "business",
            content: "核验订单",
            status: "blocked",
            detail: [
              { fields: [{ k: "订单", v: "SO-1001" }] },
              { verdict: "fail", text: "原产地证已过期" },
            ],
            display: [{ kind: "callout", tone: "warn", body: ["当前不能放行"] }],
            evidenceRefs: ["SO-1001"],
          }],
        }),
      },
    ];

    render(<TodoPanel messages={messages} sessionId="business-session" runActive />);

    expect(screen.getByRole("button", { name: "收起任务清单" })).toBeTruthy();
    expect(screen.getAllByText("核验订单").length).toBeGreaterThan(0);
    expect(screen.getByText("原产地证已过期")).toBeTruthy();
    expect(screen.getByText("当前不能放行")).toBeTruthy();
    expect(screen.getAllByText("SO-1001")).toHaveLength(2);
    expect(screen.getByText("执行详情（1）")).toBeTruthy();
    expect(screen.getByText("读取订单")).toBeTruthy();
  });
});
