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
  it("renders the plan block frameless with uniform step typography", () => {
    const { container } = render(
      <BusinessStepFlow
        event={event({
          kind: "plan",
          stepCount: 3,
          todos: [
            { id: "a", kind: "business", content: "读取订单", status: "completed" },
            { id: "b", kind: "business", content: "核验订单", status: "in_progress" },
            { id: "c", kind: "business", content: "写入结果", status: "pending" },
          ],
        })}
      />,
    );

    expect(screen.getByRole("region", { name: "业务计划" })).toBeTruthy();
    expect(screen.queryByText("共 3 步")).toBeNull();
    expect(screen.getByText("1.")).toBeTruthy();
    expect(screen.getByText("2.")).toBeTruthy();
    expect(screen.getByText("3.")).toBeTruthy();
    const rows = ["读取订单", "核验订单", "写入结果"].map((label) => screen.getByText(label));
    expect(new Set(rows.map((row) => row.className))).toHaveLength(1);
    expect(rows[0].className).not.toContain("line-through");
    expect(rows[0].className).not.toContain("font-medium");
    expect(rows[0].className).not.toContain("opacity-");
    // 去框：计划块容器不允许四边框与状态色填充
    const region = screen.getByRole("region", { name: "业务计划" });
    // 头像头部 4px + 气泡内容 2px + 计划自身 6px = 统一的 12px 消息节奏。
    expect(region.className).toContain("mt-1.5");
    expect(region.className).toContain("mb-6");
    expect(region.className).not.toContain("mt-2");
    expect(region.className).not.toContain("my-6");
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

  it("collapses terminal details by default and only toggles from the content-width title control", () => {
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

    const region = screen.getByRole("region", { name: "业务步骤已完成" });
    const titleToggle = screen.getByRole("button", { name: /核验订单.*第 1\/2 步.*已完成/ });
    const header = region.querySelector("header")!;
    expect(titleToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("business-step-chevron-right")).toBeTruthy();
    expect(screen.queryByText("17/18 张通过，1 张税号过期退回")).toBeNull();

    // 右侧空白属于 header 而不属于按钮，点击不应触发。
    expect(titleToggle.className).not.toContain("flex-1");
    fireEvent.click(header);
    expect(titleToggle.getAttribute("aria-expanded")).toBe("false");

    // 标题、步数、状态与箭头位于同一个内容宽度按钮内；步数紧跟标题且在箭头左侧。
    const title = screen.getByText("核验订单");
    const step = screen.getByText("第 1/2 步");
    expect(title.nextElementSibling).toBe(step);
    expect(step.compareDocumentPosition(screen.getByTestId("business-step-chevron-right")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(titleToggle);
    expect(titleToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("business-step-chevron-down")).toBeTruthy();
    expect(screen.getByText("17/18 张通过，1 张税号过期退回")).toBeTruthy();
    expect(screen.getByText("通过")).toBeTruthy();
    expect(screen.getByText("17")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "业务详情" })).toBeNull();
    expect(screen.queryByText("业务详情")).toBeNull();
    expect(screen.getByText("订单资料完整")).toBeTruthy();
    expect(screen.getByText("SO-1001")).toBeTruthy();
    for (const sel of NO_FILL_SELECTORS) expect(container.querySelector(sel)).toBeNull();
  });

  it("renders 业务详情 as a white key-value card, not the tinted code block", () => {
    const { container } = render(
      <BusinessStepFlow
        open
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
    // 白卡按内容收缩，但不超过业务消息的可用宽度。
    expect(card!.className).toContain("w-fit");
    expect(card!.className).toContain("max-w-full");
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
        open
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

  it("hides neutral chips duplicated by the expanded business details", () => {
    render(
      <BusinessStepFlow
        open
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

    // 与详情行同键同值的中性标签隐藏，判定类与未重复的保留。
    const stats = within(screen.getByTestId("outcome-stats"));
    expect(stats.queryByText("文件夹")).toBeNull();
    expect(stats.getByText("合规")).toBeTruthy();
    expect(stats.getByText("耗时")).toBeTruthy();
    // 详情行里那份「文件夹 15」仍在，信息没丢，只是不再出现两遍。
    expect(screen.getByText("15")).toBeTruthy();
    expect(screen.queryByText("业务详情")).toBeNull();
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

  it("collapses the full terminal body, then exposes details with debug process still collapsed", () => {
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

    const titleToggle = screen.getByRole("button", { name: /核验订单.*第 1\/2 步.*已完成/ });
    expect(titleToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/过程 ·/)).toBeNull();
    expect(screen.queryByText("全部通过")).toBeNull();
    expect(screen.queryByText("共核验 12 项字段")).toBeNull();
    expect(screen.getByText("已完成")).toBeTruthy();

    fireEvent.click(titleToggle);
    expect(screen.getByText(/过程 ·/)).toBeTruthy();
    expect(screen.getByText("全部通过")).toBeTruthy();
    expect(screen.getByText("共核验 12 项字段")).toBeTruthy();
    expect(screen.queryByText("业务详情")).toBeNull();

    const processToggle = screen.getByRole("button", { name: /过程 ·/ });
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
      <BusinessStepSectionView debugMode open section={section({ terminal })}>
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

describe("BusinessStepSectionView 外部系统动作留痕", () => {
  const terminal = () => event({
    kind: "complete",
    todo: { id: "a", kind: "business", content: "同步钉钉待办", status: "completed", outcome: { text: "已创建", tone: "ok" } },
  });

  it("整步折叠时只留标题，展开后系统动作行继续留痕", () => {
    render(
      <BusinessStepSectionView
        debugMode={false}
        section={section({ terminal: terminal(), systemActionIds: ["w1"] })}
        systemActions={<div>钉钉 · 创建待办</div>}
      >
        <div>过程细节</div>
      </BusinessStepSectionView>,
    );
    expect(screen.queryByText("钉钉 · 创建待办")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /同步钉钉待办.*已完成/ }));
    expect(screen.getByText("钉钉 · 创建待办")).toBeTruthy();
    // 非 debug 下过程仍隐藏，只有确定性的系统动作行例外。
    expect(screen.queryByText("过程细节")).toBeNull();
  });

  it("步骤进行中不重复渲染系统动作行——此时 children 已包含它", () => {
    render(
      <BusinessStepSectionView
        debugMode={false}
        section={section({ systemActionIds: ["w1"] })}
        systemActions={<div>钉钉 · 创建待办</div>}
      >
        <div>钉钉 · 创建待办</div>
      </BusinessStepSectionView>,
    );
    expect(screen.getAllByText("钉钉 · 创建待办")).toHaveLength(1);
  });

  it("debug 展开过程时不重复渲染——children 里已有这几行", () => {
    render(
      <BusinessStepSectionView
        debugMode
        open
        section={section({ terminal: terminal(), systemActionIds: ["w1"] })}
        systemActions={<div>钉钉 · 创建待办</div>}
      >
        <div>钉钉 · 创建待办</div>
      </BusinessStepSectionView>,
    );
    // debug 终态默认收起过程 → 走系统动作行分支，仍只有一份
    expect(screen.getAllByText("钉钉 · 创建待办")).toHaveLength(1);
  });

  it("无系统动作时不渲染空容器", () => {
    const { container } = render(
      <BusinessStepSectionView debugMode={false} open section={section({ terminal: terminal() })}>
        <div>过程细节</div>
      </BusinessStepSectionView>,
    );
    expect(screen.queryByText("过程细节")).toBeNull();
    expect(container.querySelectorAll("div").length).toBeGreaterThan(0);
  });
});

