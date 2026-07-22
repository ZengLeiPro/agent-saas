import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { makeWorkflowScenario } from "./workflowTestFixtures";
import { WorkflowPresentationDialog } from "./WorkflowPresentationDialog";

const chapters = Array.from({ length: 6 }, (_, index) => ({
  id: `chapter-${index + 1}`,
  title: index === 0 ? "读取客户历史" : `业务步骤 ${index + 1}`,
  narration: index === 0 ? "先读取客户关系系统中的历史记录。" : `执行第 ${index + 1} 个业务步骤。`,
  result: index === 0 ? "客户历史已经核对。" : `第 ${index + 1} 个业务结果已形成。`,
  interaction: {
    kind: index === 1 ? "confirm" as const : "next" as const,
    label: index === 1 ? "确认并继续" : "下一步",
  },
  surface: {
    kind: index === 1 ? "approval_card" as const : index === 5 ? "summary" as const : "crm_table" as const,
    title: index === 5 ? "本次改变了什么" : "客户关系系统",
    items: [{
      label: index === 0 ? "客户状态" : `状态 ${index + 1}`,
      value: index === 0 ? "老客户，正在升级采购" : "已更新",
      state: index === 1 ? "pending" as const : "success" as const,
      changed: true,
    }],
  },
}));

const scenario = makeWorkflowScenario("guided", {
  readiness: "D1_CONNECTOR",
  launch: { sampleAvailable: false, startMode: "connector", starterMessage: "接入后启动" },
  cta: { primary: "接入我的系统", secondary: "查看工作流" },
  presentation: {
    version: 1,
    dataLabel: "合成场景演示",
    limitation: "演示数据均为虚构，不会修改真实业务系统。",
    chapters,
  },
});

describe("WorkflowPresentationDialog", () => {
  it("一次只展示一个章节，并由用户控制推进", () => {
    render(
      <WorkflowPresentationDialog
        scenario={scenario}
        open
        onOpenChange={vi.fn()}
        onUseScenario={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: scenario.title })).toBeTruthy();
    expect(screen.getByText("读取客户历史")).toBeTruthy();
    expect(screen.getByText("老客户，正在升级采购")).toBeTruthy();
    expect(screen.queryByText("业务步骤 2")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    expect(screen.getByText("业务步骤 2")).toBeTruthy();
    expect(screen.getByText("这里需要人来决定")).toBeTruthy();
    expect(screen.getByText(/只模拟确认动作/)).toBeTruthy();
  });

  it("最终页承接接入动作，而不是把演示冒充真实运行", () => {
    const onUseScenario = vi.fn();
    render(
      <WorkflowPresentationDialog
        scenario={scenario}
        open
        onOpenChange={vi.fn()}
        onUseScenario={onUseScenario}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "第 6 步：业务步骤 6" }));
    expect(screen.getByText("本次改变了什么")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "接入我的系统" }));
    expect(onUseScenario).toHaveBeenCalledWith(scenario);
  });
});
