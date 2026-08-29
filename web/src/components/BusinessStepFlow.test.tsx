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

function expandEvidence() {
  const toggle = screen.getByRole("button", { name: "依据" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  return toggle;
}

const NO_FILL_SELECTORS = ["section.bg-success\\/5", "section.bg-warning\\/5", "section.bg-destructive\\/5"];

describe("BusinessStepFlow", () => {
  it("renders one frameless compact plan with static step numbers", () => {
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
    expect(screen.getByText("共 3 步")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    const rows = ["读取订单", "核验订单", "写入结果"].map((label) => screen.getByText(label));
    for (const row of rows) {
      expect(row.className).toContain("text-muted-foreground");
      expect(row.className).not.toContain("font-medium");
    }
    expect(container.querySelector(".animate-spin")).toBeNull();
    // 去框：计划块容器不允许四边框与状态色填充
    const region = screen.getByRole("region", { name: "业务计划" });
    // 统一节奏（2026-08-04）：计划块不带任何流向 margin，块间距由容器 gap 承担
    expect(region.className).not.toContain("mt-");
    expect(region.className).not.toContain("mb-");
    expect(region.className).not.toContain("my-");
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

  it("keeps terminal outcome visible while collapsing details, and only toggles from the content-width title control", () => {
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
    const titleToggle = screen.getByRole("button", { name: /核验订单.*第 1\/2 步/ });
    expect(screen.queryByText("已完成")).toBeNull();
    const header = region.querySelector("header")!;
    const statusIcon = header.querySelector(".lucide-circle-check") as SVGElement;
    expect(header.className).toContain("items-center");
    expect(header.className).toContain("gap-2");
    expect(statusIcon.classList.contains("size-3.5")).toBe(true);
    expect(statusIcon.classList.contains("text-success")).toBe(true);
    expect(statusIcon.classList.contains("mt-1")).toBe(false);
    expect(titleToggle.className).toContain("py-1");
    expect(titleToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("business-step-chevron-right")).toBeTruthy();
    expect(screen.queryByText("17/18 张通过，1 张税号过期退回")).toBeNull();
    expect(screen.queryByTestId("outcome-stats")).toBeNull();
    expect(screen.queryByText("订单资料完整")).toBeNull();
    expect(screen.queryByRole("button", { name: "依据" })).toBeNull();

    // 右侧空白属于 header 而不属于按钮，点击不应触发。
    expect(titleToggle.className).not.toContain("flex-1");
    fireEvent.click(header);
    expect(titleToggle.getAttribute("aria-expanded")).toBe("false");

    // 标题、步数与箭头位于同一个内容宽度按钮内；步数紧跟标题且在箭头左侧。
    const title = screen.getByText("核验订单");
    const step = screen.getByText("第 1/2 步");
    expect(title.nextElementSibling).toBe(step);
    expect(step.compareDocumentPosition(screen.getByTestId("business-step-chevron-right")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(titleToggle);
    expect(titleToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("business-step-chevron-down")).toBeTruthy();
    expect(screen.getAllByText("17/18 张通过，1 张税号过期退回")).toHaveLength(1);
    expect(within(screen.getByTestId("outcome-stats")).getByText("通过")).toBeTruthy();
    expect(screen.getByText("17")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "业务详情" })).toBeNull();
    expect(screen.queryByText("业务详情")).toBeNull();
    expect(screen.getByText("订单资料完整")).toBeTruthy();
    expect(screen.queryByText("SO-1001")).toBeNull();
    expandEvidence();
    expect(screen.getByText("SO-1001")).toBeTruthy();
    for (const sel of NO_FILL_SELECTORS) expect(container.querySelector(sel)).toBeNull();
  });

  it("hides the complete outcome summary whenever the row is folded", () => {
    render(
      <BusinessStepFlow
        event={event({
          kind: "complete",
          todo: {
            id: "a",
            kind: "business",
            content: "核验订单",
            status: "completed",
            outcome: {
              text: "17/18 张通过，1 张退回",
              tone: "warn",
              stat: [{ label: "通过", value: "17" }],
            },
          },
        })}
      />,
    );

    expect(screen.queryByText("17/18 张通过，1 张退回")).toBeNull();
    expect(screen.queryByTestId("outcome-stats")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /核验订单/ }));
    expect(screen.getByText("17/18 张通过，1 张退回")).toBeTruthy();
    expect(within(screen.getByTestId("outcome-stats")).getByText("通过")).toBeTruthy();
  });

  it("keeps historical detail key-value lines readable without restoring the legacy card shell", () => {
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

    const detail = container.querySelector('[data-presentation-detail-variant="plain"]') as HTMLElement;
    expect(detail).toBeTruthy();
    expect(detail.className).toContain("space-y-2");
    expect(detail.className).toContain("font-sans");
    expect(detail.className).toContain("text-sm");
    expect(detail.className).toContain("leading-5");
    expect(detail.className).toContain("mt-0");
    expect(detail.className).not.toContain("divide-y");
    expect(detail.className).not.toContain("bg-card");
    expect(detail.className).not.toContain("rounded-md");
    expect(detail.className).not.toContain("border");
    expect(detail.className).not.toContain("font-mono");
    expect(detail.style.backgroundColor).toBe("");
    expect(screen.getByText("文件夹")).toBeTruthy();
    expect(screen.getByText("15").className).not.toContain("text-primary");
    expect(screen.getByText("张三")).toBeTruthy();
  });

  it("renders current top-level detail primitives frameless while preserving their own semantics", () => {
    const { container } = render(
      <BusinessStepFlow
        open
        event={event({
          kind: "complete",
          todo: {
            id: "a",
            kind: "business",
            content: "核验资料",
            status: "completed",
            outcome: { text: "核验完成", tone: "warn" },
            detail: [
              "共核验 12 项字段",
              { insight: "资料主体一致" },
              { warn: "税号来源尚未确认" },
              { risk: "medium", text: "存在回读延迟", action: "稍后复核" },
              { verdict: "pass", text: "订单资料完整" },
            ],
          },
        })}
      />,
    );

    const detail = container.querySelector('[data-presentation-detail-variant="plain"]') as HTMLElement;
    expect(detail).toBeTruthy();
    expect(detail.className).not.toContain("border");
    expect(detail.className).not.toContain("bg-card");
    expect(detail.className).not.toContain("divide-y");
    expect(screen.getByText("共核验 12 项字段")).toBeTruthy();
    expect(screen.getByText("资料主体一致").parentElement?.className).toContain("border-primary");
    expect(screen.getByText("税号来源尚未确认")).toBeTruthy();
    expect(screen.getByText("存在回读延迟")).toBeTruthy();
    expect(screen.getByText("订单资料完整")).toBeTruthy();
  });

  it("upgrades historical section-verdict groups to branded checklist records", () => {
    const { container } = render(
      <BusinessStepFlow
        open
        event={event({
          kind: "complete",
          todo: {
            id: "a",
            kind: "business",
            content: "迁移两个需求看板",
            status: "completed",
            outcome: { text: "两表迁移完成", tone: "ok" },
            detail: [
              { section: "Azeroth 需求看板" },
              { verdict: "pass", text: "字段迁移完成" },
              { verdict: "warn", text: "存在一项差异", note: "等待复核" },
              { section: "开沿 Agent 需求看板" },
              { verdict: "fail", text: "回读失败" },
              { verdict: "pending", text: "等待人工确认" },
            ],
          },
        })}
      />,
    );

    expect(container.querySelectorAll("[data-records-block]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-records-title]")).toHaveLength(2);
    expect(screen.getByText("Azeroth 需求看板").parentElement?.className).toContain("bg-primary/5");
    expect(screen.getByText("开沿 Agent 需求看板").parentElement?.className).toContain("bg-primary/5");
    expect(screen.getByText("字段迁移完成").closest("button")?.querySelector("svg")?.classList.contains("text-success")).toBe(true);
    expect(screen.getByText("存在一项差异").closest("button")?.querySelector("svg")?.classList.contains("text-warning")).toBe(true);
    expect(screen.getByText("回读失败").closest("button")?.querySelector("svg")?.classList.contains("text-destructive")).toBe(true);
    expect(screen.getByText("等待人工确认").closest("button")?.querySelector("svg")?.classList.contains("text-muted-foreground/70")).toBe(true);
    expect(screen.getByText("等待复核")).toBeTruthy();
    expect(container.querySelector(".divide-y.bg-card")).toBeNull();
  });

  it("renders titled records cards inside a terminal business summary", () => {
    const { container } = render(
      <BusinessStepFlow
        open
        event={event({
          kind: "complete",
          todo: {
            id: "a",
            kind: "business",
            content: "核对工作树",
            status: "completed",
            outcome: { text: "工作树核对完成", tone: "ok" },
            display: [{
              kind: "records",
              layout: "rows",
              title: "核对工作树状态",
              items: [
                { label: "工作树", value: "干净" },
                { label: "远端", value: "已同步" },
              ],
            }],
          },
        })}
      />,
    );

    expect(screen.getByText("核对工作树状态")).toBeTruthy();
    expect(container.querySelector("[data-records-title]")?.className).toContain("bg-primary/5");
    expect(container.querySelector("[data-records-block]")?.className).toContain("border-primary/20");
  });

  it("forces TodoWrite facts and list blocks onto separate rows", () => {
    const { container } = render(
      <BusinessStepFlow
        open
        event={event({
          kind: "complete",
          todo: {
            id: "a",
            kind: "business",
            content: "整理客户资料",
            status: "completed",
            outcome: { text: "资料整理完成", tone: "ok" },
            display: [
              {
                kind: "records",
                layout: "grid",
                title: "关键事实",
                items: [
                  { label: "客户", value: "开沿科技" },
                  { label: "资料数", value: "3" },
                  { label: "状态", value: "已核验" },
                ],
              },
              {
                kind: "records",
                layout: "rows",
                title: "处理清单",
                items: [{ label: "归档", value: "已完成" }],
              },
            ],
          },
        })}
      />,
    );

    const records = container.querySelectorAll("[data-records-block]");
    expect(records).toHaveLength(2);
    const summary = records[0]?.parentElement;
    expect(summary).toBe(records[1]?.parentElement);
    expect(summary?.className).toContain("flex-col");
    expect(summary?.className).toContain("gap-3");
    expect(summary?.children).toHaveLength(2);
    expect(summary?.children[0]).toBe(records[0]);
    expect(summary?.children[1]).toBe(records[1]);
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
    expect(screen.queryByText("进行中")).toBeNull();
    expect(screen.getByTestId("process-content")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("hides terminal outcome with details and debug process while collapsed", () => {
    const terminal = event({
      kind: "complete",
      todo: {
        id: "a",
        kind: "business",
        content: "核验订单",
        status: "completed",
        outcome: { text: "全部通过", tone: "ok", stat: [{ label: "字段", value: "12" }] },
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

    const titleToggle = screen.getByRole("button", { name: /核验订单.*第 1\/2 步/ });
    const header = titleToggle.closest("header")!;
    const statusIcon = header.querySelector(".lucide-circle-check") as SVGElement;
    expect(header.className).toContain("items-center");
    expect(header.className).toContain("gap-2");
    expect(statusIcon.classList.contains("size-3.5")).toBe(true);
    expect(statusIcon.classList.contains("text-success")).toBe(true);
    expect(statusIcon.classList.contains("mt-1")).toBe(false);
    expect(titleToggle.className).toContain("py-1");
    expect(titleToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/过程 ·/)).toBeNull();
    expect(screen.queryByText("全部通过")).toBeNull();
    expect(screen.queryByTestId("outcome-stats")).toBeNull();
    expect(screen.queryByText("共核验 12 项字段")).toBeNull();
    expect(screen.queryByText("已完成")).toBeNull();

    fireEvent.click(titleToggle);
    expect(screen.getByText(/过程 ·/)).toBeTruthy();
    expect(screen.getAllByText("全部通过")).toHaveLength(1);
    expect(screen.getByText("共核验 12 项字段")).toBeTruthy();
    expect(screen.queryByText("业务详情")).toBeNull();

    const processToggle = screen.getByRole("button", { name: /过程 ·/ });
    expect(processToggle.lastElementChild?.classList.contains("lucide-chevron-right")).toBe(true);
    fireEvent.click(processToggle);
    expect(screen.getByTestId("process-content")).toBeTruthy();
  });

  it("keeps tables and warnings visible while process and evidence refs switch exclusively", () => {
    const terminal = event({
      kind: "complete",
      todo: {
        id: "a",
        kind: "business",
        content: "核验订单",
        status: "completed",
        outcome: { text: "核验完成", tone: "ok" },
        display: [
          {
            kind: "records",
            layout: "rows",
            title: "核验依据",
            items: [{ label: "订单", value: "已核验" }],
          },
          {
            kind: "callout",
            tone: "warn",
            title: "税号预警",
            body: ["发现 1 项异常"],
          },
        ],
        evidenceRefs: ["evidence:SO-1001"],
      },
    });
    const { container } = render(
      <BusinessStepSectionView debugMode open section={section({ terminal })}>
        <div data-testid="process-content">工具活动内容</div>
      </BusinessStepSectionView>,
    );

    // 表格、预警属于常显业务小结，不受「依据」标签折叠状态影响。
    expect(screen.getByText("核验依据")).toBeTruthy();
    expect(screen.getByText("税号预警")).toBeTruthy();
    expect(screen.getByText("发现 1 项异常")).toBeTruthy();
    expect(screen.queryByText("evidence:SO-1001")).toBeNull();

    const controls = container.querySelector("[data-business-step-disclosures]") as HTMLElement;
    expect(controls).toBeTruthy();
    expect(controls.className).toContain("flex");
    expect(controls.className).not.toContain("grid-cols-2");
    const processToggle = within(controls).getByRole("button", { name: /过程 · 1 项/ });
    const evidenceToggle = within(controls).getByRole("button", { name: "依据" });
    expect(processToggle.nextElementSibling).toBe(evidenceToggle);
    expect(processToggle.className).not.toContain("flex-1");
    expect(evidenceToggle.className).not.toContain("flex-1");

    fireEvent.click(processToggle);
    expect(screen.getByTestId("process-content")).toBeTruthy();
    expect(processToggle.getAttribute("aria-expanded")).toBe("true");
    expect(evidenceToggle.getAttribute("aria-expanded")).toBe("false");
    expect(controls.nextElementSibling?.getAttribute("data-business-step-panel")).toBe("process");

    fireEvent.click(evidenceToggle);
    expect(screen.queryByTestId("process-content")).toBeNull();
    expect(processToggle.getAttribute("aria-expanded")).toBe("false");
    expect(evidenceToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("evidence:SO-1001")).toBeTruthy();
    expect(controls.nextElementSibling?.getAttribute("data-business-step-panel")).toBe("evidence");
    expect(screen.getByText("核验依据")).toBeTruthy();
    expect(screen.getByText("税号预警")).toBeTruthy();

    fireEvent.click(processToggle);
    expect(screen.getByTestId("process-content")).toBeTruthy();
    expect(screen.queryByText("evidence:SO-1001")).toBeNull();
    expect(processToggle.getAttribute("aria-expanded")).toBe("true");
    expect(evidenceToggle.getAttribute("aria-expanded")).toBe("false");
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

  it("marks compacted open sections as waiting to resume instead of not started", () => {
    const { container } = render(
      <BusinessStepSectionView debugMode section={section({ resumePending: true })}>
        <div data-testid="process-content">残留内容</div>
      </BusinessStepSectionView>,
    );

    expect(screen.getByText("已暂停，待恢复")).toBeTruthy();
    expect(container.querySelector(".lucide-clock-3")).toBeTruthy();
    expect(container.querySelector(".lucide-play")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
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

  it("processAnomaly 只在展开后渲染浅色「过程有异常」角标，不恢复终态标签", () => {
    const terminal = event({
      kind: "complete",
      todo: { id: "a", kind: "business", content: "同步钉钉待办", status: "completed", outcome: { text: "已创建", tone: "ok" } },
    });
    render(
      <BusinessStepSectionView debugMode section={section({ terminal, processAnomaly: true })}>
        {null}
      </BusinessStepSectionView>,
    );

    expect(screen.queryByText("已完成")).toBeNull();
    expect(screen.queryByText("过程有异常")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /同步钉钉待办/ }));
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

  it("终态折叠时隐藏 outcome 与系统动作，展开后系统动作行继续留痕", () => {
    render(
      <BusinessStepSectionView
        debugMode={false}
        section={section({ terminal: terminal(), systemActionIds: ["w1"] })}
        systemActions={<div>钉钉 · 创建待办</div>}
      >
        <div>过程细节</div>
      </BusinessStepSectionView>,
    );
    expect(screen.queryByText("已创建")).toBeNull();
    expect(screen.queryByText("钉钉 · 创建待办")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /同步钉钉待办/ }));
    expect(screen.getByText("已创建")).toBeTruthy();
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

