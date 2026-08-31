import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BusinessStepEventItem, TodoItem } from "@agent/shared";

import { BusinessStepFlow, businessStepOverallStatus } from "./BusinessStepFlow";
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

function todo(status: TodoItem["status"], tone?: "ok" | "warn" | "fail"): TodoItem {
  return {
    id: status,
    kind: "business",
    content: status,
    status,
    ...(tone ? { outcome: { text: "已处理", tone } } : {}),
  };
}

describe("businessStepOverallStatus", () => {
  it("只把 completed 计入完成数，并按运行、阻断、失败、等待排序", () => {
    expect(businessStepOverallStatus([
      todo("completed", "warn"),
      todo("waiting"),
      todo("failed"),
      todo("blocked"),
      todo("in_progress"),
    ])).toEqual({ completed: 1, label: "运行中", tone: "active" });
    expect(businessStepOverallStatus([todo("completed"), todo("blocked"), todo("failed"), todo("waiting")]))
      .toEqual({ completed: 1, label: "已阻断", tone: "danger" });
    expect(businessStepOverallStatus([todo("completed"), todo("failed"), todo("waiting")]))
      .toEqual({ completed: 1, label: "有失败", tone: "danger" });
    expect(businessStepOverallStatus([todo("completed"), todo("waiting")]))
      .toEqual({ completed: 1, label: "等待中", tone: "pending" });
  });

  it("识别全部完成和待处理，异常 outcome tone 不影响完成计数", () => {
    expect(businessStepOverallStatus([todo("completed", "warn"), todo("completed", "fail")]))
      .toEqual({ completed: 2, label: "已完成", tone: "success" });
    expect(businessStepOverallStatus([todo("pending")]))
      .toEqual({ completed: 0, label: "待处理", tone: "neutral" });
  });
});

describe("BusinessStepFlow 主导航卡", () => {
  it("一份计划只渲染一个有界自适应主卡，每个 Todo 恰好一行", () => {
    const { container } = render(
      <BusinessStepFlow event={event()} sessionId="session-1" selected={null} onSelect={() => undefined} />,
    );

    expect(container.querySelectorAll("[data-business-step-plan]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-business-step-select-key]")).toHaveLength(3);
    const card = container.querySelector("[data-business-step-plan]");
    expect(card?.className).toContain("w-full");
    expect(card?.className).toContain("md:w-fit");
    expect(card?.className).toContain("md:min-w-[min(520px,100%)]");
    expect(card?.className).toContain("md:max-w-[min(760px,100%)]");
  });

  it("头部显示完成数和整体状态，不再显示“共 N 步”", () => {
    render(<BusinessStepFlow event={event()} sessionId="session-1" selected={null} />);

    expect(screen.getByText("1/3")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.queryByText("共 3 步")).toBeNull();
  });

  it("主行只显示 content、状态和两位序号，不泄露 activeForm 或详情字段", () => {
    render(<BusinessStepFlow event={event()} sessionId="session-1" selected={null} onSelect={() => undefined} />);

    expect(screen.getByText("核验订单")).toBeTruthy();
    expect(screen.queryByText("正在逐张核验订单")).toBeNull();
    expect(screen.queryByText("读取 18 张订单")).toBeNull();
    expect(screen.queryByText("过程详情不应出现在主卡")).toBeNull();
    expect(screen.queryByText("核验明细")).toBeNull();
    expect(screen.queryByText("order:18")).toBeNull();
    expect(screen.getByText("01")).toBeTruthy();
    expect(screen.getByText("02")).toBeTruthy();
    expect(screen.getByText("03")).toBeTruthy();
    expect(screen.queryByText("2/3")).toBeNull();
  });

  it("completed 标题保持正文色，只有 pending 使用 muted，长标题采用两行截断", () => {
    render(<BusinessStepFlow event={event()} sessionId="session-1" selected={null} />);

    expect(screen.getByText("读取订单").className).toContain("text-foreground");
    expect(screen.getByText("写入结果").className).toContain("text-muted-foreground");
    expect(screen.getByText("核验订单").className).toContain("[-webkit-line-clamp:2]");
    expect(screen.getByText("核验订单").className).toContain("break-words");
    expect(screen.getByText("核验订单").getAttribute("title")).toBe("核验订单");
  });

  it("多步骤显示连接线，单步骤不显示多余连接线", () => {
    const { container, rerender } = render(<BusinessStepFlow event={event()} selected={null} />);
    expect(container.querySelector("[data-business-step-list]")?.getAttribute("data-business-step-connected"))
      .toBe("true");

    rerender(<BusinessStepFlow event={event({ todos: [todo("pending")] })} selected={null} />);
    expect(container.querySelector("[data-business-step-list]")?.getAttribute("data-business-step-connected"))
      .toBe("false");
  });

  it("点击整行回传稳定选择，并同时表达 selected 与 current，保留无障碍关系", () => {
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
    const selectedCurrent = screen.getByRole("button", { name: /核验订单/ });
    expect(selectedCurrent.getAttribute("aria-selected")).toBe("true");
    expect(selectedCurrent.getAttribute("aria-current")).toBe("step");
    expect(selectedCurrent.className).toContain("before:bg-primary");
    expect(selectedCurrent.className).not.toContain("ring-primary/25");
    expect(selectedCurrent.className).toContain("focus-visible:ring-2");
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

  it("reset 关闭的历史计划不再把旧 in_progress 步骤标成当前运行", () => {
    render(<BusinessStepFlow event={event({ isClosed: true })} sessionId="session-1" selected={null} />);
    const row = screen.getByRole("button", { name: /核验订单/ });
    expect(row.getAttribute("aria-current")).toBeNull();
    expect(row.getAttribute("data-business-step-current")).toBe("false");
    expect(within(row).getByLabelText("已结束")).toBeTruthy();
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
