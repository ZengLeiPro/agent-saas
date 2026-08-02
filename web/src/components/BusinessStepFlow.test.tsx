import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BusinessStepEventItem } from "@agent/shared";

import { BusinessStepFlow } from "./BusinessStepFlow";

function event(partial: Partial<BusinessStepEventItem> & Pick<BusinessStepEventItem, "kind">): BusinessStepEventItem {
  return {
    type: "business_step",
    id: `bs-test-${partial.kind}`,
    anchorMessageId: "anchor-1",
    ...partial,
  };
}

describe("BusinessStepFlow", () => {
  it("renders the plan block with step statuses and no status-colored fill", () => {
    const { container } = render(
      <BusinessStepFlow
        event={event({
          kind: "plan",
          stepCount: 2,
          todos: [
            { id: "a", kind: "business", content: "核验订单", status: "in_progress" },
            { id: "b", kind: "business", content: "写入结果", status: "pending" },
          ],
        })}
      />,
    );

    expect(screen.getByRole("region", { name: "业务计划" })).toBeTruthy();
    expect(screen.getByText("共 2 步")).toBeTruthy();
    expect(screen.getByText("核验订单")).toBeTruthy();
    expect(screen.getByText("写入结果")).toBeTruthy();
    // 视觉纪律：容器不允许整卡状态色填充
    expect(container.querySelector(".bg-success\\/5")).toBeNull();
    expect(container.querySelector(".bg-warning\\/5")).toBeNull();
    expect(container.querySelector(".bg-destructive\\/5")).toBeNull();
  });

  it("shows a spinner on the active plan row while the run is active", () => {
    const { container } = render(
      <BusinessStepFlow
        event={event({
          kind: "plan",
          isCurrent: true,
          todos: [{ id: "a", kind: "business", content: "核验订单", status: "in_progress" }],
          stepCount: 1,
        })}
      />,
    );
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("renders the start trace as a low-noise single row", () => {
    render(
      <BusinessStepFlow
        event={event({
          kind: "start",
          todo: { id: "b", kind: "business", content: "写入结果", status: "in_progress" },
          stepIndex: 2,
          stepCount: 3,
        })}
      />,
    );
    expect(screen.getByText("写入结果")).toBeTruthy();
    expect(screen.getByText("第 2/3 步")).toBeTruthy();
  });

  it("prefers activeForm on the currently running start row", () => {
    const { container } = render(
      <BusinessStepFlow
        event={event({
          kind: "start",
          isCurrent: true,
          todo: {
            id: "b",
            kind: "business",
            content: "写入结果",
            status: "in_progress",
            activeForm: "正在写入核验结果",
          },
        })}
      />,
    );
    expect(screen.getByText("正在写入核验结果")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("renders the terminal summary with detail, display and evidence", () => {
    const { container } = render(
      <BusinessStepFlow
        event={event({
          kind: "complete",
          stepIndex: 1,
          stepCount: 2,
          todo: {
            id: "a",
            kind: "business",
            content: "核验订单",
            status: "completed",
            detail: [{ verdict: "pass", text: "订单资料完整" }],
            display: [{ kind: "callout", tone: "info", body: ["共核验 12 项字段"] }],
            evidenceRefs: ["SO-1001"],
          },
        })}
      />,
    );

    expect(screen.getByRole("region", { name: "业务步骤已完成" })).toBeTruthy();
    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.getByText("订单资料完整")).toBeTruthy();
    expect(screen.getByText("共核验 12 项字段")).toBeTruthy();
    expect(screen.getByText("SO-1001")).toBeTruthy();
    // 状态色只落 icon 与徽标，容器保持中性
    expect(container.querySelector("section.bg-success\\/5")).toBeNull();
  });

  it("renders fail and wait terminal blocks with their own semantics", () => {
    const { rerender } = render(
      <BusinessStepFlow
        event={event({
          kind: "fail",
          todo: { id: "a", kind: "business", content: "核验订单", status: "failed" },
        })}
      />,
    );
    expect(screen.getByRole("region", { name: "业务步骤失败" })).toBeTruthy();

    rerender(
      <BusinessStepFlow
        event={event({
          kind: "wait",
          todo: { id: "a", kind: "business", content: "等待人工审批", status: "waiting" },
        })}
      />,
    );
    expect(screen.getByRole("region", { name: "业务步骤等待中" })).toBeTruthy();
  });

  it("renders the lightweight update row", () => {
    render(<BusinessStepFlow event={event({ kind: "update", stepCount: 4 })} />);
    expect(screen.getByText("计划已调整 · 共 4 步")).toBeTruthy();
  });
});
