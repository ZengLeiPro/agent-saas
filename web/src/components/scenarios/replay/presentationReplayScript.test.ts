import { describe, expect, it } from "vitest";
import { makeWorkflowScenario } from "../workflowTestFixtures";
import { presentationToReplayScript } from "./presentationReplayScript";

function makeScenarioWithApproval() {
  return makeWorkflowScenario("quote-loop", {
    presentation: {
      version: 1,
      dataLabel: "合成场景演示",
      limitation: "演示数据均为虚构。",
      chapters: [
        {
          id: "read",
          title: "读取询价",
          narration: "读取客户、产品和历史报价。",
          result: "报价所需事实已经齐备。",
          interaction: { kind: "next", label: "下一步" },
          surface: {
            kind: "crm_table",
            title: "客户关系系统",
            items: [{ label: "询价状态", value: "资料齐备", state: "success", changed: true }],
          },
        },
        {
          id: "approve",
          title: "负责人确认报价",
          narration: "把毛利、账期和交付边界提交负责人审核。",
          result: "报价边界得到人工确认。",
          interaction: { kind: "confirm", label: "批准报价" },
          surface: {
            kind: "approval_card",
            title: "报价审批",
            items: [{ label: "毛利率", value: "24.8%", state: "warning" }],
          },
        },
        {
          id: "verify",
          title: "回读送达结果",
          narration: "重新读取邮件送达和 CRM 状态。",
          result: "报价已送达，CRM 已写回最新状态。",
          interaction: { kind: "next", label: "完成" },
          surface: {
            kind: "summary",
            title: "业务终态",
            items: [{ label: "报价状态", value: "已送达", state: "success", changed: true }],
          },
        },
      ],
    },
  });
}

describe("presentationToReplayScript", () => {
  it("把已有分章演示统一投影为产品原生 Hero 回放", () => {
    const script = presentationToReplayScript(makeScenarioWithApproval());
    expect(script?.mode).toBe("hero");
    expect(script?.steps).toHaveLength(3);
    expect(script?.steps[0].blocks[0].kind).toBe("prompt");
    expect(script?.steps.every((step) => step.blocks.some((block) => block.presentation))).toBe(true);
    expect(script?.steps.at(-1)?.blocks.at(-1)?.content).toContain("本次会话改变了什么");
  });

  it("confirm 章节生成真实审批门禁和批准留痕", () => {
    const script = presentationToReplayScript(makeScenarioWithApproval());
    const approval = script?.steps[1].approval;
    expect(approval?.approveLabel).toBe("批准报价");
    expect(approval?.facts).toEqual([{ label: "毛利率", value: "24.8%" }]);
    expect(approval?.approvedBlocks.some((block) => block.toolName === "Approval")).toBe(true);
  });

  it("右侧按被仿真的系统分视图，不同界面形态用不同控件", () => {
    const script = presentationToReplayScript(makeScenarioWithApproval());
    const base = script?.steps[0].blocks.find((block) => block.presentation?.panelBase)?.presentation?.panelBase;
    expect(base).toBeTruthy();
    const views = Object.fromEntries((base?.views ?? []).map((view) => [view.key, view]));
    // 三章分别落在业务系统 / 审批 / 终态核对，加上留痕共 4 个视图
    expect(Object.keys(views).sort()).toEqual(["approval", "audit", "records", "summary"]);
    expect(views.records.widget.kind).toBe("table");
    expect(views.summary.widget.kind).toBe("table");
    expect(views.approval.widget.kind).toBe("rows");
    expect(views.audit.widget.kind).toBe("feed");
    // 窗口标题带系统名，底部写清楚接了哪些系统
    expect(base?.foot).toContain("已连接：");
    expect(base?.foot).toContain("CRM");
  });

  it("每一步聚焦到这一步真正动了的系统", () => {
    const script = presentationToReplayScript(makeScenarioWithApproval());
    const focusOf = (index: number) => script?.steps[index].blocks
      .flatMap((block) => block.presentation?.panel ?? [])
      .find((patch) => patch.op === "focus");
    expect(focusOf(0)).toMatchObject({ op: "focus", view: "records" });
    expect(focusOf(1)).toMatchObject({ op: "focus", view: "approval" });
    expect(focusOf(2)).toMatchObject({ op: "focus", view: "summary" });
  });

  it("工具摘要展开是本步的业务字段，正文不再重复同一句话", () => {
    const script = presentationToReplayScript(makeScenarioWithApproval());
    const tool = script?.steps[0].blocks.find((block) => block.kind === "tool_use");
    expect(tool?.presentation?.detail).toEqual([
      "读取客户、产品和历史报价。",
      { tree: "└", k: "询价状态", v: "资料齐备" },
    ]);
    const text = script?.steps[0].blocks.find((block) => block.kind === "text");
    expect(text?.content).toBe("报价所需事实已经齐备。");
    expect(text?.content).not.toContain("这一步完成后");
  });

  it("终态不使用中文冒号前的加粗定界符（会渲染成字面星号）", () => {
    const script = presentationToReplayScript(makeScenarioWithApproval());
    const last = script?.steps.at(-1)?.blocks.at(-1)?.content ?? "";
    expect(last).toContain("**业务结果**：");
    expect(last).not.toContain("**业务结果：**");
  });

  it("每个演示动作都有诚实的真实产出方与差距登记", () => {
    const script = presentationToReplayScript(makeScenarioWithApproval());
    expect(script?.sources).toHaveLength(3);
    for (const source of script?.sources ?? []) {
      expect(source.producer.trim().length).toBeGreaterThan(0);
      expect(source.state).toBe("needs-change");
      expect(source.gap?.trim().length).toBeGreaterThan(0);
    }
  });
});
