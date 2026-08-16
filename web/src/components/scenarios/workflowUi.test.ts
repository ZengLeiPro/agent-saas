import { describe, expect, it } from "vitest";
import { filterWorkflowScenarios, workflowCta } from "./workflowUi";
import { makeWorkflowScenario } from "./workflowTestFixtures";

describe("Workflow V3 UI 纯契约", () => {
  it("outcome × role × industry 为 AND，且同一 catalog id 不复制", () => {
    const target = makeWorkflowScenario("target", {
      goalTags: ["追回款", "控风险"],
      roleIds: ["finance", "sales"],
      industryTags: ["manufacturing", "trade"],
    });
    const result = filterWorkflowScenarios(
      [target, target, makeWorkflowScenario("other", { goalTags: ["保交付"] })],
      { outcome: "追回款", role: "finance", industry: "trade" },
    );
    expect(result.map((item) => item.id)).toEqual(["target"]);
  });

  it("三轴任一不匹配都不会进入结果", () => {
    const target = makeWorkflowScenario("target", { goalTags: ["追回款"], roleIds: ["finance"], industryTags: ["trade"] });
    expect(filterWorkflowScenarios([target], { outcome: "追回款", role: "sales", industry: "trade" })).toEqual([]);
    expect(filterWorkflowScenarios([target], { outcome: "保交付", role: "finance", industry: "trade" })).toEqual([]);
    expect(filterWorkflowScenarios([target], { outcome: "追回款", role: "finance", industry: "retail" })).toEqual([]);
  });

  it("D0/D1/D2 CTA 不把接入或项目集成冒充当前即用", () => {
    expect(workflowCta(makeWorkflowScenario("d0")).action).toBe("chat");
    expect(workflowCta(makeWorkflowScenario("d1", {
      readiness: "D1_CONNECTOR",
      launch: { sampleAvailable: false, startMode: "connector", entry: { kind: "business_event", content: "业务系统出现一条待处理事件。" }, starterMessage: "业务系统出现一条待处理事件。" },
      cta: { primary: "接入我的系统", secondary: "查看工作流" },
    }))).toEqual({ action: "connector", label: "接入我的系统", secondaryLabel: "查看工作流" });
    expect(workflowCta(makeWorkflowScenario("d2", {
      readiness: "D2_PROJECT",
      launch: { sampleAvailable: false, startMode: "diagnosis", entry: { kind: "business_event", content: "预约诊断" }, starterMessage: "预约诊断" },
      cta: { primary: "预约落地诊断", secondary: "查看行业演示" },
    })).action).toBe("diagnosis");
  });


  it("有受控演示时先展示工作现场，真实接入保留为次动作", () => {
    const scenario = makeWorkflowScenario("presentation", {
      readiness: "D1_CONNECTOR",
      launch: { sampleAvailable: false, startMode: "connector", entry: { kind: "business_event", content: "业务系统出现一条待处理事件。" }, starterMessage: "业务系统出现一条待处理事件。" },
      cta: { primary: "接入我的系统", secondary: "查看工作流" },
      presentation: {
        version: 1,
        dataLabel: "合成场景演示",
        limitation: "演示数据均为示例。",
        chapters: Array.from({ length: 6 }, (_, index) => ({
          id: `chapter-${index + 1}`,
          title: `第 ${index + 1} 步`,
          narration: "展示当前业务动作。",
          result: "当前业务状态已变化。",
          interaction: { kind: "next" as const, label: "下一步" },
          surface: {
            kind: "crm_table" as const,
            title: "客户关系系统",
            items: [{ label: "状态", value: "已更新", state: "success" as const }],
          },
        })),
      },
    });
    expect(workflowCta(scenario)).toEqual({
      action: "presentation",
      label: "看演示",
      secondaryLabel: "接入我的系统",
      secondaryAction: "connector",
    });
  });
  it("手写 ReplayScript 与 presentation 都显示演示入口，无剧本场景不显示", () => {
    const handwritten = makeWorkflowScenario("catalog-evidence-backed-communication-create", {
      readiness: "D1_CONNECTOR",
      launch: { sampleAvailable: false, startMode: "connector", entry: { kind: "business_event", content: "业务系统出现一条待处理事件。" }, starterMessage: "业务系统出现一条待处理事件。" },
      cta: { primary: "接入我的系统", secondary: "查看工作流" },
    });
    expect(workflowCta(handwritten).action).toBe("presentation");

    const noReplay = makeWorkflowScenario("no-replay", {
      readiness: "D1_CONNECTOR",
      launch: { sampleAvailable: false, startMode: "connector", entry: { kind: "business_event", content: "业务系统出现一条待处理事件。" }, starterMessage: "业务系统出现一条待处理事件。" },
      cta: { primary: "接入我的系统", secondary: "查看工作流" },
    });
    expect(workflowCta(noReplay).action).toBe("connector");
  });

});
