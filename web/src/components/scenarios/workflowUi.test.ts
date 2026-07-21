import { describe, expect, it } from "vitest";
import { filterWorkflowScenarios, workflowCta, workflowIsolatedDemoFor } from "./workflowUi";
import { makeWorkflowLibrary } from "./workflowTestFixtures";
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
      launch: { sampleAvailable: false, startMode: "connector", starterMessage: "接入后启动" },
      cta: { primary: "接入我的系统", secondary: "查看工作流" },
    }))).toEqual({ action: "connector", label: "接入我的系统", secondaryLabel: "查看工作流" });
    expect(workflowCta(makeWorkflowScenario("d2", {
      readiness: "D2_PROJECT",
      launch: { sampleAvailable: false, startMode: "diagnosis", starterMessage: "预约诊断" },
      cta: { primary: "预约落地诊断", secondary: "查看行业演示" },
    })).action).toBe("diagnosis");
  });

  it("只有真实 workflow replay 且有公开路径才显示回放动作", () => {
    const noPath = makeWorkflowScenario("no-path", {
      launch: { sampleAvailable: true, startMode: "replay", starterMessage: "查看演示" },
      demo: { evidenceLevel: "workflow_replay" },
    });
    expect(workflowCta(noPath)).toEqual({ action: "detail", label: "查看工作流" });
    expect(workflowCta({ ...noPath, demo: { evidenceLevel: "workflow_replay", sharePath: "/workflow-replay/demo" } }).action).toBe("replay");
  });

  it("只有服务端明确声明可运行且为 D1/D2 才形成独立隔离演示入口", () => {
    const scenario = makeWorkflowScenario("isolated", {
      readiness: "D1_CONNECTOR",
      launch: {
        sampleAvailable: false,
        isolatedDemoAvailable: true,
        startMode: "connector",
        starterMessage: "运行隔离演示",
      },
    });
    const library = makeWorkflowLibrary([scenario]);
    library.demos = [{
      id: "demo-isolated",
      workflowId: scenario.workflowId,
      catalogScenarioId: scenario.id,
      primaryType: scenario.primaryType,
      environment: { kind: "isolated_stateful", dataLabel: "synthetic" },
      title: "隔离演示",
      environmentLabel: "专用隔离演示系统",
      before: [],
      timeline: [],
      after: [],
      evidence: [],
    }];
    expect(workflowIsolatedDemoFor(library, scenario)).toBe(true);
    expect(workflowIsolatedDemoFor(library, { ...scenario, readiness: "D0_CURRENT" })).toBeNull();
  });
});
