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


});
