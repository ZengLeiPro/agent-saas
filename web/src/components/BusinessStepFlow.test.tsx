import { fireEvent, render, screen, within } from "@testing-library/react";
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

  it("renders the terminal block frameless with business details expanded by default", () => {
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
    // 业务详情默认展开，用户仍可按需收起。
    const summaryToggle = screen.getByRole("button", { name: "业务详情" });
    expect(summaryToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("订单资料完整")).toBeTruthy();
    expect(screen.getByText("SO-1001")).toBeTruthy();
    fireEvent.click(summaryToggle);
    expect(screen.queryByText("订单资料完整")).toBeNull();
    expect(screen.queryByText("SO-1001")).toBeNull();
    for (const sel of NO_FILL_SELECTORS) expect(container.querySelector(sel)).toBeNull();
  });

  it("renders 业务详情 as a white key-value card, not the tinted code block", () => {
    const { container } = render(
      <BusinessStepFlow
        event={event({
          kind: "complete",
          todo: {
            id: "a",
            kind: "business",
            content: "盘点资料包",
            status: "completed",
            outcome: { text: "资料包盘点完成", tone: "ok" },
            detail: [{ k: "文件夹", v: "15" }, { k: "负责人", v: "张三" }],
          },
        })}
      />,
    );

    const card = container.querySelector(".divide-y.bg-card");
    expect(card).toBeTruthy();
    // 白卡不用等宽排版，也不再用代码块底色
    expect(card!.className).not.toContain("font-mono");
    expect((card as HTMLElement).style.backgroundColor).toBe("");
    // 关键值（数字）走主题强调色，普通值保持深色
    expect(screen.getByText("15").className).toContain("text-primary");
    expect(screen.getByText("张三").className).not.toContain("text-primary");
  });

  it("colors verdict chips green/red and keeps counting chips neutral", () => {
    render(
      <BusinessStepFlow
        event={event({
          kind: "complete",
          todo: {
            id: "a",
            kind: "business",
            content: "合规校验",
            status: "completed",
            outcome: {
              text: "合规校验完成",
              tone: "warn",
              stat: [
                { label: "合规", value: "通过" },
                { label: "税号", value: "未通过" },
                { label: "退回", value: "1" },
              ],
            },
          },
        })}
      />,
    );

    expect(screen.getByText("合规").className).toContain("text-success");
    expect(screen.getByText("税号").className).toContain("text-destructive");
    expect(screen.getByText("退回").className).toContain("text-muted-foreground");
  });

  it("hides duplicated neutral chips while 业务详情 is open, restores them once collapsed", () => {
    render(
      <BusinessStepFlow
        event={event({
          kind: "complete",
          todo: {
            id: "a",
            kind: "business",
            content: "盘点资料包",
            status: "completed",
            outcome: {
              text: "资料包盘点完成",
              tone: "ok",
              stat: [
                { label: "文件夹", value: "15" },
                { label: "合规", value: "通过" },
                { label: "耗时", value: "42s" },
              ],
            },
            detail: [{ k: "文件夹", v: "15" }],
          },
        })}
      />,
    );

    // 默认展开：与详情行同键同值的中性标签隐藏，判定类与未重复的保留
    const expanded = within(screen.getByTestId("outcome-stats"));
    expect(expanded.queryByText("文件夹")).toBeNull();
    expect(expanded.getByText("合规")).toBeTruthy();
    expect(expanded.getByText("耗时")).toBeTruthy();
    // 详情行里那份「文件夹 15」仍在，信息没丢，只是不再出现两遍
    expect(screen.getByText("15")).toBeTruthy();

    // 收起业务详情：标签成为唯一的结构化信息位，全部显示
    fireEvent.click(screen.getByRole("button", { name: "业务详情" }));
    const collapsed = within(screen.getByTestId("outcome-stats"));
    expect(collapsed.getByText("文件夹")).toBeTruthy();
    expect(collapsed.getByText("15")).toBeTruthy();
    expect(collapsed.getByText("合规")).toBeTruthy();
    expect(collapsed.getByText("耗时")).toBeTruthy();
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

  it("expands business details and collapses debug process once terminal", () => {
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

    // 业务详情自动展开，调试过程仍按需展开。
    expect(screen.queryByTestId("process-content")).toBeNull();
    expect(screen.getByText(/过程 ·/)).toBeTruthy();
    expect(screen.getByText("全部通过")).toBeTruthy();
    expect(screen.getByText("共核验 12 项字段")).toBeTruthy();
    expect(screen.getByText("已完成")).toBeTruthy();

    const summaryToggle = screen.getByRole("button", { name: "业务详情" });
    const processToggle = screen.getByRole("button", { name: /过程 ·/ });
    expect(summaryToggle.getAttribute("aria-expanded")).toBe("true");
    expect(summaryToggle.lastElementChild?.classList.contains("rotate-90")).toBe(true);
    expect(processToggle.lastElementChild?.classList.contains("lucide-chevron-right")).toBe(true);

    fireEvent.click(processToggle);
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

  it("processAnomaly 时在终态徽标旁渲染浅色「过程有异常」角标", () => {
    const terminal = event({
      kind: "complete",
      todo: { id: "a", kind: "business", content: "同步钉钉待办", status: "completed", outcome: { text: "已创建", tone: "ok" } },
    });
    render(
      <BusinessStepSectionView debugMode section={section({ terminal, processAnomaly: true })}>
        {null}
      </BusinessStepSectionView>,
    );

    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.getByText("过程有异常")).toBeTruthy();
  });

  it("无 processAnomaly 时不渲染角标", () => {
    const terminal = event({
      kind: "complete",
      todo: { id: "a", kind: "business", content: "同步钉钉待办", status: "completed" },
    });
    render(
      <BusinessStepSectionView debugMode section={section({ terminal })}>
        {null}
      </BusinessStepSectionView>,
    );

    expect(screen.queryByText("过程有异常")).toBeNull();
  });
});

