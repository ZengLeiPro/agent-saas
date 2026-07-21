import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScenarioItem } from "@agent/shared";

import { CronCreationWizard, resolveCronScenario } from "./CronCreationWizard";
import type { WorkflowOnboardingContext } from "./workflowOnboarding";
import { authFetch } from "@/lib/authFetch";

vi.mock("@/lib/authFetch", () => ({
  authFetch: vi.fn(),
}));

const scenario: ScenarioItem = {
  id: "boss-competitor-daily",
  title: "竞品动态晨报",
  role: "boss",
  industries: ["manufacturing"],
  mode: "recurring",
  pitch: "每天整理竞品变化",
  story: "输入对象 → 自动汇总",
  promptTemplate: "请跟进 {{target}}",
  slots: [{ key: "target", label: "竞品", example: "同行A" }],
  requires: ["web", "dingtalk"],
  recommendCron: true,
  signalAdaptation: {
    dailyEmptyStreakToWeekly: 3,
    userNoOpenStreakToPause: 5,
    emptyContentFallback: "无明显变化时发周报",
  },
  pushSlot: {
    humanReviewRequired: false,
    target: "self",
    channel: "ding_work_notification",
  },
};

function workflowContext(
  primaryType: WorkflowOnboardingContext["scenario"]["primaryType"],
  readiness: WorkflowOnboardingContext["scenario"]["readiness"],
): WorkflowOnboardingContext {
  return {
    scenario: {
      id: "catalog-watch",
      workflowId: "workflow-watch",
      title: "订单异常持续巡检",
      primaryType,
      readiness,
      launch: {
        sampleAvailable: true,
        startMode: "replay",
        starterMessage: "查看订单异常",
      },
      cta: { primary: "用示例数据体验" },
      demo: {
        evidenceLevel: "workflow_replay",
        sharePath: "/share/workflows/demo-watch",
      },
    },
    schedule: {
      scheduleCapable: true,
      cronScenario: scenario,
    },
  };
}

describe("CronCreationWizard", () => {
  it("submits the three-step form and dispatches cron configured event", async () => {
    const authFetchMock = vi.mocked(authFetch);
    authFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          cronJobId: "cron-1",
          scenarioId: scenario.id,
          createdAt: "2026-07-05T00:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onCreated = vi.fn();
    const onEvent = vi.fn();
    window.addEventListener("kaiyan:cron-configured", onEvent);

    render(
      <CronCreationWizard
        open
        scenario={scenario}
        onOpenChange={vi.fn()}
        onCreated={onCreated}
      />,
    );

    fireEvent.change(screen.getByLabelText("监测对象"), { target: { value: "同行A" } });
    fireEvent.keyDown(screen.getByLabelText("监测对象"), { key: "Enter" });
    fireEvent.click(screen.getByText("下一步"));
    fireEvent.click(screen.getByText("下一步"));
    fireEvent.click(screen.getByText("创建监测"));

    await waitFor(() => {
      expect(authFetchMock).toHaveBeenCalledWith(
        "/api/scenarios/create-cron",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("同行A"),
        }),
      );
    });
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ cronJobId: "cron-1" }));
    expect(onEvent).toHaveBeenCalled();
    window.removeEventListener("kaiyan:cron-configured", onEvent);
  });

  it("forces manager review when the scenario requires it", () => {
    render(
      <CronCreationWizard
        open
        scenario={{
          ...scenario,
          pushSlot: {
            humanReviewRequired: true,
            target: "manager",
            channel: "ding_work_notification",
          },
        }}
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("监测对象"), { target: { value: "重点客户" } });
    fireEvent.keyDown(screen.getByLabelText("监测对象"), { key: "Enter" });
    fireEvent.click(screen.getByText("下一步"));
    fireEvent.click(screen.getByText("下一步"));

    expect(screen.getByText("该场景涉及对外发送，必须先发给主管确认。")).toBeTruthy();
    expect(screen.getByText("发给我").closest("button")?.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("发到团队群").closest("button")?.hasAttribute("disabled")).toBe(true);
  });

  it("blocks ACT/LOOP and non-D0 workflows before any Cron request", () => {
    const authFetchMock = vi.mocked(authFetch);
    const callCount = authFetchMock.mock.calls.length;
    const actContext = workflowContext("ACT", "D0_CURRENT");
    const d1WatchContext = workflowContext("WATCH", "D1_CONNECTOR");

    expect(resolveCronScenario(null, actContext)).toBeNull();
    expect(resolveCronScenario(null, d1WatchContext)).toBeNull();

    render(
      <CronCreationWizard
        open
        scenario={null}
        workflowContext={actContext}
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByText("此工作流不能配置常驻监测")).toBeTruthy();
    expect(screen.queryByText("创建监测")).toBeNull();
    expect(authFetchMock.mock.calls).toHaveLength(callCount);
  });

  it("uses the proven legacy compatibility scenario for a D0 WATCH", async () => {
    const authFetchMock = vi.mocked(authFetch);
    const callCount = authFetchMock.mock.calls.length;
    authFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          cronJobId: "cron-v3",
          scenarioId: scenario.id,
          createdAt: "2026-07-21T00:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(
      <CronCreationWizard
        open
        scenario={null}
        workflowContext={workflowContext("WATCH", "D0_CURRENT")}
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("监测对象"), { target: { value: "订单A" } });
    fireEvent.keyDown(screen.getByLabelText("监测对象"), { key: "Enter" });
    fireEvent.click(screen.getByText("下一步"));
    fireEvent.click(screen.getByText("下一步"));
    fireEvent.click(screen.getByText("创建监测"));

    await waitFor(() => {
      expect(authFetchMock.mock.calls).toHaveLength(callCount + 1);
      const [, request] = authFetchMock.mock.calls[callCount] ?? [];
      expect(request?.body).toContain(`"scenarioId":"${scenario.id}"`);
    });
  });
});
