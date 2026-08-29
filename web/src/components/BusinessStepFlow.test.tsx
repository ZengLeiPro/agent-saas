import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BusinessStepEventItem } from "@agent/shared";

import { BusinessStepFlow } from "./BusinessStepFlow";
import { detailSelection } from "./businessStepViewModel";

function event(partial: Partial<BusinessStepEventItem> = {}): BusinessStepEventItem {
  return {
    type: "business_step",
    id: "bs-plan-1",
    anchorMessageId: "todo-1",
    runId: "run-1",
    kind: "plan",
    stepCount: 3,
    todos: [
      {
        id: "read",
        kind: "business",
        content: "读取订单",
        status: "completed",
        outcome: { text: "读取 18 张订单", stat: [{ label: "订单", value: "18" }] },
      },
      {
        id: "verify",
        kind: "business",
        content: "核验订单",
        activeForm: "正在逐张核验订单",
        status: "in_progress",
        detail: ["过程详情不应出现在主卡"],
        display: [{ kind: "records", layout: "rows", title: "核验明细", items: [{ label: "通过", value: "17" }] }],
        evidenceRefs: ["order:18"],
      },
      { id: "write", kind: "business", content: "写入结果", status: "pending" },
    ],
    ...partial,
  };
}

describe("BusinessStepFlow 主导航卡", () => {
  it("一份计划只渲染一个圆角主卡，每个 Todo 恰好一行", () => {
    const { container } = render(
      <BusinessStepFlow event={event()} sessionId="session-1" selected={null} onSelect={() => undefined} />,
    );

    expect(container.querySelectorAll("[data-business-step-plan]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-business-step-select-key]")).toHaveLength(3);
    expect(screen.getByText("读取订单")).toBeTruthy();
    expect(screen.getByText("核验订单")).toBeTruthy();
    expect(screen.getByText("写入结果")).toBeTruthy();
    expect(container.querySelector("[data-business-step-plan]")?.className).toContain("rounded-2xl");
  });

  it("主行只显示 content、状态和序号，不泄露 activeForm 或详情字段", () => {
    render(<BusinessStepFlow event={event()} sessionId="session-1" selected={null} onSelect={() => undefined} />);

    expect(screen.getByText("核验订单")).toBeTruthy();
    expect(screen.queryByText("正在逐张核验订单")).toBeNull();
    expect(screen.queryByText("读取 18 张订单")).toBeNull();
    expect(screen.queryByText("过程详情不应出现在主卡")).toBeNull();
    expect(screen.queryByText("核验明细")).toBeNull();
    expect(screen.queryByText("order:18")).toBeNull();
    expect(screen.queryByRole("button", { name: /全部展开|全部收起/ })).toBeNull();
  });

  it("点击整行回传稳定 session + run + plan + todo key，并表达选择关系", () => {
    const onSelect = vi.fn();
    const selection = detailSelection("session-1", "run-1", "bs-plan-1", "id:verify");
    const { rerender } = render(
      <BusinessStepFlow event={event()} sessionId="session-1" selected={null} onSelect={onSelect} />,
    );
    const row = screen.getByRole("button", { name: /核验订单/ });

    expect(row.getAttribute("aria-selected")).toBe("false");
    expect(row.getAttribute("aria-current")).toBe("step");
    expect(row.getAttribute("aria-controls")).toBe("business-step-detail-panel");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(selection);

    rerender(
      <BusinessStepFlow event={event()} sessionId="session-1" selected={selection} onSelect={onSelect} />,
    );
    expect(screen.getByRole("button", { name: /核验订单/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("Enter 与 Space 使用原生 button 语义触发选择", () => {
    const onSelect = vi.fn();
    render(<BusinessStepFlow event={event()} sessionId="session-1" selected={null} onSelect={onSelect} />);
    const row = screen.getByRole("button", { name: /写入结果/ });
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("start / terminal / update 事件不再生成第二套主区步骤正文", () => {
    const { container } = render(
      <BusinessStepFlow
        event={event({
          id: "bs-complete",
          kind: "complete",
          todos: undefined,
          todo: { id: "verify", kind: "business", content: "核验订单", status: "completed" },
        })}
        selected={null}
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});
