import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BusinessTodoGroup } from "@agent/shared";

import { BusinessTodoBlock } from "./BusinessTodoBlock";

function businessGroup(): BusinessTodoGroup {
  return {
    type: "business_todo",
    id: "business-todo-todo-start",
    turnId: "user-1",
    anchorMessageId: "todo-start",
    isActive: false,
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
    activitiesByTodo: {
      "id:verify-order": [{
        id: "read-order",
        toolName: "Read",
        label: "读取订单",
        status: "completed",
      }],
    },
    toolMessagesByTodo: {
      "id:verify-order": [{
        id: "read-order",
        type: "tool_use",
        toolName: "Read",
        toolId: "read-order",
        toolInput: "{}",
        executionStatus: "completed",
        presentation: { title: "读取订单" },
      }],
    },
  };
}

describe("BusinessTodoBlock", () => {
  it("renders rich business steps directly without a panel expand button", () => {
    render(<BusinessTodoBlock group={businessGroup()} />);

    expect(screen.getByRole("region", { name: "业务步骤" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /任务清单/ })).toBeNull();
    expect(screen.getByText("核验订单")).toBeTruthy();
    expect(screen.getByText("已阻断")).toBeTruthy();
    expect(screen.getByText("原产地证已过期")).toBeTruthy();
    expect(screen.getByText("当前不能放行")).toBeTruthy();
    expect(screen.getAllByText("SO-1001")).toHaveLength(2);
    expect(screen.getByText("执行详情（1）")).toBeTruthy();
    expect(screen.getByText("读取订单")).toBeTruthy();
  });

  it("shows an active step spinner only for the current running turn", () => {
    const group = businessGroup();
    group.isActive = true;
    group.todos[0] = {
      id: "verify-order",
      kind: "business",
      content: "核验订单",
      status: "in_progress",
      activeForm: "正在核验订单",
    };

    const { container } = render(<BusinessTodoBlock group={group} />);

    expect(screen.getByText("正在核验订单")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });
});
