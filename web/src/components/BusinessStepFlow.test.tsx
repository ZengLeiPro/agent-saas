import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BusinessStepEventItem, BusinessStepSection } from "@agent/shared";

import { BusinessStepFlow, BusinessStepSectionView } from "./BusinessStepFlow";

function event(partial: Partial<BusinessStepEventItem> & Pick<BusinessStepEventItem, "kind">): BusinessStepEventItem {
  return {
    type: "business_step",
    id: `bs-test-${partial.kind}`,
    anchorMessageId: "anchor-1",
    ...partial,
  };
}

function section(partial: Partial<BusinessStepSection>): BusinessStepSection {
  return {
    type: "business_step_section",
    id: "sec-test",
    start: event({
      kind: "start",
      todo: { id: "a", kind: "business", content: "核验订单", status: "in_progress", activeForm: "正在核验订单" },
      stepIndex: 1,
      stepCount: 2,
    }),
    // 过程计数基于 items（children 与其一一对应）；给一个含单条消息的活动组。
    items: [{
      type: "activity_group",
      id: "ag-1",
      items: [{ id: "th-1", type: "thinking", content: "t" }],
      isActive: false,
    }],
    isActive: false,
    ...partial,
  };
}

const NO_FILL_SELECTORS = ["section.bg-success\\/5", "section.bg-warning\\/5", "section.bg-destructive\\/5"];

describe("BusinessStepFlow", () => {
  it("renders the plan block frameless with step statuses", () => {
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
    // 去框：计划块容器不允许四边框与状态色填充
    const region = screen.getByRole("region", { name: "业务计划" });
    expect(region.className).not.toContain("border ");
    expect(region.className).not.toContain("rounded-lg");
    for (const sel of NO_FILL_SELECTORS) expect(container.querySelector(sel)).toBeNull();
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

  it("renders the terminal block frameless with outcome, detail and evidence", () => {
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
            outcome: {
              text: "17/18 张通过，1 张税号过期退回",
              tone: "warn",
              stat: [
                { label: "通过", value: "17" },
                { label: "退回", value: "1" },
              ],
            },
            detail: [{ verdict: "pass", text: "订单资料完整" }],
            evidenceRefs: ["SO-1001"],
          },
        })}
      />,
    );

    expect(screen.getByRole("region", { name: "业务步骤已完成" })).toBeTruthy();
    expect(screen.getByText("已完成")).toBeTruthy();
    // outcome：一句话结果 + 分流计数徽标；tone=warn 用警示色文字
    expect(screen.getByText("17/18 张通过，1 张税号过期退回")).toBeTruthy();
    expect(screen.getByText("通过")).toBeTruthy();
    expect(screen.getByText("17")).toBeTruthy();
    expect(screen.getByText("订单资料完整")).toBeTruthy();
    expect(screen.getByText("SO-1001")).toBeTruthy();
    for (const sel of NO_FILL_SELECTORS) expect(container.querySelector(sel)).toBeNull();
  });

  it("renders the lightweight update row", () => {
    render(<BusinessStepFlow event={event({ kind: "update", stepCount: 4 })} />);
    expect(screen.getByText("计划已调整 · 共 4 步")).toBeTruthy();
  });
});

describe("BusinessStepSectionView", () => {
  it("shows activeForm title with spinner and expanded process while running", () => {
    const { container } = render(
      <BusinessStepSectionView debugMode section={section({ isActive: true })}>
        <div data-testid="process-content">工具活动内容</div>
      </BusinessStepSectionView>,
    );

    expect(screen.getByText("正在核验订单")).toBeTruthy();
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(screen.getByTestId("process-content")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("collapses process but keeps outcome and summary visible once terminal", () => {
    const terminal = event({
      kind: "complete",
      todo: {
        id: "a",
        kind: "business",
        content: "核验订单",
        status: "completed",
        outcome: { text: "全部通过", tone: "ok" },
        detail: ["共核验 12 项字段"],
      },
      stepIndex: 1,
      stepCount: 2,
    });
    render(
      <BusinessStepSectionView debugMode section={section({ terminal })}>
        <div data-testid="process-content">工具活动内容</div>
      </BusinessStepSectionView>,
    );

    // 过程默认折叠为一行；outcome 与小结常显——折的是过程，不折结论。
    expect(screen.queryByTestId("process-content")).toBeNull();
    expect(screen.getByText(/过程 ·/)).toBeTruthy();
    expect(screen.getByText("全部通过")).toBeTruthy();
    expect(screen.getByText("共核验 12 项字段")).toBeTruthy();
    expect(screen.getByText("已完成")).toBeTruthy();

    // 点开过程
    fireEvent.click(screen.getByText(/过程 ·/));
    expect(screen.getByTestId("process-content")).toBeTruthy();
  });

  it("renders interrupted open section without spinner or badge", () => {
    const { container } = render(
      <BusinessStepSectionView debugMode section={section({ isActive: false })}>
        <div data-testid="process-content">残留内容</div>
      </BusinessStepSectionView>,
    );

    expect(screen.getByText("核验订单")).toBeTruthy();
    expect(screen.queryByText("进行中")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    // 未封节（无终态）时过程保持可见
    expect(screen.getByTestId("process-content")).toBeTruthy();
  });

  it("marks failed sections with fail semantics and outcome tone", () => {
    const terminal = event({
      kind: "fail",
      todo: {
        id: "a",
        kind: "business",
        content: "核验订单",
        status: "failed",
        outcome: { text: "税号校验失败，已终止", tone: "fail" },
      },
    });
    render(
      <BusinessStepSectionView debugMode section={section({ terminal })}>
        {null}
      </BusinessStepSectionView>,
    );

    expect(screen.getByRole("region", { name: "业务步骤失败" })).toBeTruthy();
    expect(screen.getByText("税号校验失败，已终止")).toBeTruthy();
  });
});
