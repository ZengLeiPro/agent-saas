import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScenarioDetailDialog } from "./ScenarioDetailDialog";
import { makeWorkflowLibrary, makeWorkflowScenario } from "./workflowTestFixtures";

describe("ScenarioDetailDialog", () => {
  it("展示业务事件到价值证明，不渲染内部实现字段", () => {
    const scenario = {
      ...makeWorkflowScenario("detail"),
      promptTemplate: "INTERNAL_PROMPT_CANARY",
      operationRef: "INTERNAL_OPERATION_CANARY",
      toolCalls: ["INTERNAL_TOOL_CANARY"],
    } as unknown as ReturnType<typeof makeWorkflowScenario>;
    render(
      <ScenarioDetailDialog
        scenario={scenario}
        library={makeWorkflowLibrary([scenario])}
        vertical="all"
        businessModel="all"
        maturity="all"
        open
        onOpenChange={vi.fn()}
        onPrimaryAction={vi.fn()}
      />,
    );
    expect(screen.getByText("业务事件")).toBeTruthy();
    expect(screen.getByText("读取来源")).toBeTruthy();
    expect(screen.getByText("判断与不确定项")).toBeTruthy();
    expect(screen.getByText("实际动作")).toBeTruthy();
    expect(screen.getByText("人审与权限")).toBeTruthy();
    expect(screen.getByText("系统前后状态")).toBeTruthy();
    expect(screen.getByText("完成证明与价值")).toBeTruthy();
    expect(document.body.textContent).not.toContain("INTERNAL_PROMPT_CANARY");
    expect(document.body.textContent).not.toContain("INTERNAL_OPERATION_CANARY");
    expect(document.body.textContent).not.toContain("INTERNAL_TOOL_CANARY");
  });

  it("只在真实 sharePath 存在时提供明确的运行回放入口", () => {
    const replay = makeWorkflowScenario("replay", {
      launch: { sampleAvailable: true, startMode: "replay", starterMessage: "查看回放" },
      demo: { evidenceLevel: "workflow_replay", sharePath: "/workflow-replays/public-1" },
    });
    const onPrimaryAction = vi.fn();
    render(
      <ScenarioDetailDialog
        scenario={replay}
        library={makeWorkflowLibrary([replay])}
        vertical="all"
        businessModel="all"
        maturity="all"
        open
        onOpenChange={vi.fn()}
        onPrimaryAction={onPrimaryAction}
      />,
    );
    screen.getByRole("button", { name: "查看已验收回放" }).click();
    expect(onPrimaryAction).toHaveBeenCalledWith("replay", replay);
  });

  it("D1/D2 将隔离演示作为独立入口且明确不等于客户系统接入", () => {
    const scenario = makeWorkflowScenario("isolated", {
      readiness: "D1_CONNECTOR",
      launch: {
        sampleAvailable: false,
        isolatedDemoAvailable: true,
        startMode: "connector",
        starterMessage: "接入后启动",
      },
      cta: { primary: "接入我的系统", secondary: "查看工作流" },
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
    const onPrimaryAction = vi.fn();
    render(
      <ScenarioDetailDialog
        scenario={scenario}
        library={library}
        vertical="all"
        businessModel="all"
        maturity="all"
        open
        onOpenChange={vi.fn()}
        onPrimaryAction={onPrimaryAction}
      />,
    );
    screen.getByRole("button", { name: "运行隔离演示" }).click();
    expect(onPrimaryAction).toHaveBeenCalledWith("isolated-demo", scenario);
    expect(screen.getByText(/演示结果不代表已接入你的业务系统/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "接入我的系统" })).toBeTruthy();
  });
});
