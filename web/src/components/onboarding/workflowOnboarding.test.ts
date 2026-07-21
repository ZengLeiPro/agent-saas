import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioItem } from "@agent/shared";

const startWorkflowDemoMock = vi.hoisted(() => vi.fn());
const abandonWorkflowDemoLaunchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workflowDemoApi", () => ({
  startWorkflowDemo: startWorkflowDemoMock,
  abandonWorkflowDemoLaunch: abandonWorkflowDemoLaunchMock,
}));

import {
  buildWorkflowOnboardingPlan,
  isWorkflowCronEligible,
  sendWorkflowExperience,
  type WorkflowOnboardingContext,
} from "./workflowOnboarding";

const cronScenario: ScenarioItem = {
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

function context(
  primaryType: WorkflowOnboardingContext["scenario"]["primaryType"],
  readiness: WorkflowOnboardingContext["scenario"]["readiness"],
  options: { replay?: boolean; schedule?: boolean; startMode?: "chat" | "replay" | "connector" | "diagnosis" } = {},
): WorkflowOnboardingContext {
  const replay = options.replay === true;
  return {
    scenario: {
      id: `${primaryType.toLowerCase()}-${readiness.toLowerCase()}`,
      workflowId: `workflow-${primaryType.toLowerCase()}`,
      title: "测试工作流",
      primaryType,
      readiness,
      launch: {
        sampleAvailable: replay,
        startMode: options.startMode ?? (replay ? "replay" : "chat"),
        starterMessage: "用示例数据开始",
      },
      cta: { primary: "立即试一试" },
      demo: replay
        ? { evidenceLevel: "workflow_replay", sharePath: "/share/workflows/demo-1" }
        : { evidenceLevel: "design_only" },
    },
    ...(options.schedule
      ? { schedule: { scheduleCapable: true as const, cronScenario } }
      : {}),
  };
}

describe("buildWorkflowOnboardingPlan", () => {
  it("routes D1 to connector and D2 to diagnosis regardless of launch copy", () => {
    const d1 = buildWorkflowOnboardingPlan(context("CREATE", "D1_CONNECTOR", { startMode: "chat" }));
    const d2 = buildWorkflowOnboardingPlan(context("WATCH", "D2_PROJECT", { startMode: "chat", schedule: true }));

    expect(d1.activate.action).toBe("connector");
    expect(d1.activate.cta).toBe("接入我的系统");
    expect(d2.activate.action).toBe("diagnosis");
    expect(d2.activate.cta).toBe("预约落地诊断");
  });

  it("uses chat or a published replay for D0 according to launch", () => {
    expect(buildWorkflowOnboardingPlan(context("CREATE", "D0_CURRENT")).experience.action).toBe("chat");
    expect(buildWorkflowOnboardingPlan(context("ACT", "D0_CURRENT", { replay: true })).experience.action).toBe("replay");
    expect(buildWorkflowOnboardingPlan(context("ACT", "D0_CURRENT", { startMode: "replay" })).experience.action).toBe("detail");
  });

  it("only recommends Cron for a D0 WATCH with explicit schedule proof", () => {
    const eligible = context("WATCH", "D0_CURRENT", { schedule: true });
    const unproven = context("WATCH", "D0_CURRENT");
    const d1Watch = context("WATCH", "D1_CONNECTOR", { schedule: true });

    expect(isWorkflowCronEligible(eligible)).toBe(true);
    expect(buildWorkflowOnboardingPlan(eligible).activate.action).toBe("cron");
    expect(isWorkflowCronEligible(unproven)).toBe(false);
    expect(buildWorkflowOnboardingPlan(unproven).activate.action).not.toBe("cron");
    expect(isWorkflowCronEligible(d1Watch)).toBe(false);
  });

  it.each(["CREATE", "ACT", "LOOP"] as const)(
    "never turns %s into Cron even when schedule proof is supplied",
    (primaryType) => {
      const input = context(primaryType, "D0_CURRENT", { schedule: true });
      expect(isWorkflowCronEligible(input)).toBe(false);
      expect(buildWorkflowOnboardingPlan(input).activate.action).not.toBe("cron");
    },
  );
});

describe("sendWorkflowExperience", () => {
  beforeEach(() => {
    startWorkflowDemoMock.mockReset();
    abandonWorkflowDemoLaunchMock.mockReset().mockResolvedValue(undefined);
  });

  it("只在真实发送成功后发体验事件，预填或失败都不会提前推进", async () => {
    const dispatched: Event[] = [];
    const eventTarget = { dispatchEvent: (event: Event) => { dispatched.push(event); return true; } };
    const workflow = context("CREATE", "D0_CURRENT");

    await sendWorkflowExperience(async () => undefined, workflow.scenario.launch.starterMessage, workflow, eventTarget);
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0] as CustomEvent).detail).toEqual({ workflowId: "workflow-create" });

    dispatched.length = 0;
    await sendWorkflowExperience(async () => undefined, "   ", workflow, eventTarget);
    expect(dispatched).toHaveLength(0);

    await sendWorkflowExperience(async () => undefined, "另一个普通问题", workflow, eventTarget);
    expect(dispatched).toHaveLength(0);

    await expect(sendWorkflowExperience(
      async () => { throw new Error("发送失败"); },
      workflow.scenario.launch.starterMessage,
      workflow,
      eventTarget,
    )).rejects.toThrow("发送失败");
    expect(dispatched).toHaveLength(0);
  });

  it("只在用户发送冻结起手指令时初始化隔离 run 并透传服务端绑定", async () => {
    const workflow = {
      ...context("ACT", "D1_CONNECTOR"),
      demoLaunch: {
        catalogScenarioId: "catalog-01",
        idempotencyKey: "stable-key-01",
      },
    };
    startWorkflowDemoMock.mockResolvedValue({
      runId: "11111111-1111-4111-8111-111111111111",
      eventId: "event-01",
    });
    const send = vi.fn().mockResolvedValue(undefined);

    await sendWorkflowExperience(
      send,
      workflow.scenario.launch.starterMessage,
      workflow,
      { dispatchEvent: () => true },
    );

    expect(startWorkflowDemoMock).toHaveBeenCalledWith("catalog-01", "stable-key-01");
    expect(send).toHaveBeenCalledWith({
      workflowDemo: {
        runId: "11111111-1111-4111-8111-111111111111",
        eventId: "event-01",
      },
    });

    startWorkflowDemoMock.mockClear();
    await sendWorkflowExperience(send, "普通问题", workflow, { dispatchEvent: () => true });
    expect(startWorkflowDemoMock).not.toHaveBeenCalled();
    expect(send).toHaveBeenLastCalledWith(undefined);
  });

  it("Workflow 首条消息未获 ACK 时回收未绑定 run，且不推进体验事件", async () => {
    const workflow = {
      ...context("LOOP", "D0_CURRENT"),
      demoLaunch: { catalogScenarioId: "catalog-01", idempotencyKey: "stable-key-02" },
    };
    const workflowDemo = {
      runId: "22222222-2222-4222-8222-222222222222",
      eventId: "event-01",
    };
    startWorkflowDemoMock.mockResolvedValue(workflowDemo);
    const eventTarget = { dispatchEvent: vi.fn(() => true) };

    await expect(sendWorkflowExperience(
      async () => { throw new Error("ACK timeout"); },
      workflow.scenario.launch.starterMessage,
      workflow,
      eventTarget,
    )).rejects.toThrow("ACK timeout");

    expect(abandonWorkflowDemoLaunchMock).toHaveBeenCalledWith(workflowDemo.runId);
    expect(eventTarget.dispatchEvent).not.toHaveBeenCalled();
  });
});
