import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogScenarioPublic, ScenarioItem } from "@agent/shared";

import { FIRST_DAY_GUIDE_STORAGE_KEY, FirstDayGuideBar, guideReducer } from "./FirstDayGuideBar";
import type { WorkflowOnboardingContext } from "./workflowOnboarding";

const legacyWatch: ScenarioItem = {
  id: "legacy-watch",
  title: "旧版巡检",
  role: "boss",
  industries: ["manufacturing"],
  mode: "recurring",
  pitch: "持续巡检",
  story: "读取 → 判断 → 提醒",
  promptTemplate: "巡检 {{target}}",
  slots: [{ key: "target", label: "对象", example: "订单A" }],
  requires: ["web"],
  recommendCron: true,
};

function workflowContext(
  primaryType: CatalogScenarioPublic["primaryType"],
  readiness: CatalogScenarioPublic["readiness"],
  schedule = false,
): WorkflowOnboardingContext {
  return {
    scenario: {
      id: "workflow-test",
      workflowId: "workflow-test",
      title: "测试工作流",
      primaryType,
      readiness,
      launch: {
        sampleAvailable: true,
        startMode: "replay",
        starterMessage: "开始测试",
      },
      cta: { primary: "用示例数据体验" },
      demo: {
        evidenceLevel: "workflow_replay",
        sharePath: "/share/workflows/demo-1",
      },
    },
    ...(schedule
      ? { schedule: { scheduleCapable: true as const, cronScenario: legacyWatch } }
      : {}),
  };
}

describe("guideReducer", () => {
  it("covers the designed transitions", () => {
    expect(guideReducer("aha", { type: "EXAMPLE_DEMO_OPENED" })).toBe("cron");
    expect(guideReducer("aha", { type: "CRON_CONFIGURED" })).toBe("cron");
    expect(guideReducer("aha", { type: "FIRST_DINGTALK_INVOKE" })).toBe("sprint");
    expect(guideReducer("cron", { type: "FIRST_DINGTALK_INVOKE" })).toBe("sprint");
    expect(guideReducer("sprint", { type: "FIRST_DINGTALK_INVOKE" })).toBe("done");
    expect(guideReducer("done", { type: "STAGE_TIMEOUT" })).toBe("done");
    expect(guideReducer("closed", { type: "EXAMPLE_DEMO_OPENED" })).toBe("closed");
  });
});

describe("FirstDayGuideBar", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("responds to custom events and can close itself", () => {
    render(
      <FirstDayGuideBar
        activeScenario={{
          id: "boss-1",
          day1PathSteps: [
            {
              stage: "T+0-30min",
              userAction: "先输入竞品名",
              aiAction: "整理动态",
              userSees: "晨报",
            },
          ],
        }}
        onOpenCronWizard={vi.fn()}
        onOpenExampleDemo={vi.fn()}
      />,
    );

    expect(screen.getByText("先输入竞品名")).toBeTruthy();

    act(() => {
      window.dispatchEvent(new CustomEvent("kaiyan:example-demo-opened"));
    });
    expect(screen.getByText("把它设成每天自动跑")).toBeTruthy();

    act(() => {
      window.dispatchEvent(new CustomEvent("kaiyan:cron-configured"));
    });
    expect(screen.getByText("今天再跑 3 个真实任务")).toBeTruthy();

    fireEvent.click(screen.getByTitle("关闭引导"));
    expect(screen.queryByText("今天再跑 3 个真实任务")).toBeNull();
  });

  it("使用 v3 storage key，不继承旧版已关闭状态", () => {
    window.localStorage.setItem("kaiyan:firstDayGuide:v2", "closed");
    render(
      <FirstDayGuideBar
        activeWorkflow={workflowContext("CREATE", "D0_CURRENT")}
        onOpenCronWizard={vi.fn()}
        onOpenExampleDemo={vi.fn()}
      />,
    );
    expect(screen.getByText("先看示例成果与核验证据")).toBeTruthy();
    expect(window.localStorage.getItem(FIRST_DAY_GUIDE_STORAGE_KEY)).toBe("aha");
  });

  it("soft-exits after the configured timeout", () => {
    vi.useFakeTimers();
    const onSoftExitAcknowledged = vi.fn();

    render(
      <FirstDayGuideBar
        onOpenCronWizard={vi.fn()}
        onOpenExampleDemo={vi.fn()}
        onSoftExitAcknowledged={onSoftExitAcknowledged}
        stageTimeoutMs={100}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(onSoftExitAcknowledged).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("keeps the legacy fallback but does not present a one-time task as Cron", () => {
    render(
      <FirstDayGuideBar
        activeScenario={{ id: "legacy-create", mode: "oneshot" }}
        onOpenCronWizard={vi.fn()}
        onOpenExampleDemo={vi.fn()}
      />,
    );
    act(() => window.dispatchEvent(new CustomEvent("kaiyan:example-demo-opened")));
    expect(screen.getByText("打开任务模板")).toBeTruthy();
    expect(screen.queryByText("配置常驻监测")).toBeNull();
  });

  it("guides D1 to a connector and D2 to diagnosis without calling either a Cron", () => {
    const onConnectWorkflow = vi.fn();
    const onRequestDiagnosis = vi.fn();

    const { unmount } = render(
      <FirstDayGuideBar
        activeWorkflow={workflowContext("WATCH", "D1_CONNECTOR", true)}
        onOpenCronWizard={vi.fn()}
        onOpenExampleDemo={vi.fn()}
        onConnectWorkflow={onConnectWorkflow}
        onOpenWorkflowCron={vi.fn()}
      />,
    );
    act(() => window.dispatchEvent(new CustomEvent("kaiyan:workflow-experience-opened")));
    expect(screen.getByText("接入我的系统")).toBeTruthy();
    fireEvent.click(screen.getByText("接入我的系统"));
    expect(onConnectWorkflow).toHaveBeenCalledOnce();

    unmount();
    window.localStorage.clear();
    render(
      <FirstDayGuideBar
        activeWorkflow={workflowContext("LOOP", "D2_PROJECT", true)}
        onOpenCronWizard={vi.fn()}
        onOpenExampleDemo={vi.fn()}
        onRequestDiagnosis={onRequestDiagnosis}
        onOpenWorkflowCron={vi.fn()}
      />,
    );
    act(() => window.dispatchEvent(new CustomEvent("kaiyan:workflow-experience-opened")));
    expect(screen.getByText("预约落地诊断")).toBeTruthy();
    fireEvent.click(screen.getByText("预约落地诊断"));
    expect(onRequestDiagnosis).toHaveBeenCalledOnce();
    expect(screen.queryByText("配置常驻监测")).toBeNull();
  });

  it("only shows the Cron step for an explicitly eligible D0 WATCH", () => {
    const onOpenWorkflowCron = vi.fn();
    const { unmount } = render(
      <FirstDayGuideBar
        activeWorkflow={workflowContext("WATCH", "D0_CURRENT", true)}
        onOpenCronWizard={vi.fn()}
        onOpenExampleDemo={vi.fn()}
        onOpenWorkflowCron={onOpenWorkflowCron}
      />,
    );
    act(() => window.dispatchEvent(new CustomEvent("kaiyan:workflow-experience-opened")));
    fireEvent.click(screen.getByText("配置常驻监测"));
    expect(onOpenWorkflowCron).toHaveBeenCalledOnce();

    unmount();
    window.localStorage.clear();
    render(
      <FirstDayGuideBar
        activeWorkflow={workflowContext("ACT", "D0_CURRENT", true)}
        onOpenCronWizard={vi.fn()}
        onOpenExampleDemo={vi.fn()}
        onOpenWorkflowCron={vi.fn()}
      />,
    );
    act(() => window.dispatchEvent(new CustomEvent("kaiyan:workflow-experience-opened")));
    expect(screen.queryByText("配置常驻监测")).toBeNull();
  });

  it("falls back to workflow details when no V3 Cron callback is wired", () => {
    render(
      <FirstDayGuideBar
        activeWorkflow={workflowContext("WATCH", "D0_CURRENT", true)}
        onOpenCronWizard={vi.fn()}
        onOpenExampleDemo={vi.fn()}
      />,
    );
    act(() => window.dispatchEvent(new CustomEvent("kaiyan:workflow-experience-opened")));
    expect(screen.queryByText("配置常驻监测")).toBeNull();
    expect(screen.getByText("查看真实回放")).toBeTruthy();
  });
});
