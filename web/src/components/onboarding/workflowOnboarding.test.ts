import { describe, expect, it, vi } from "vitest";
import type { ScenarioItem } from "@agent/shared";

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
  options: { schedule?: boolean; startMode?: "chat" | "connector" | "diagnosis" } = {},
): WorkflowOnboardingContext {
  return {
    scenario: {
      id: `${primaryType.toLowerCase()}-${readiness.toLowerCase()}`,
      workflowId: `workflow-${primaryType.toLowerCase()}`,
      title: "测试工作流",
      primaryType,
      readiness,
      launch: {
        sampleAvailable: false,
        startMode: options.startMode ?? "chat",
        starterMessage: "用示例数据开始",
      },
      cta: { primary: "立即试一试" },
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
  it("只在真实发送成功后发体验事件，失败不会提前推进", async () => {
    const workflow = context("LOOP", "D0_CURRENT");
    const eventTarget = { dispatchEvent: vi.fn(() => true) };
    const send = vi.fn().mockResolvedValue(undefined);

    await sendWorkflowExperience(send, workflow.scenario.launch.starterMessage, workflow, eventTarget);

    expect(send).toHaveBeenCalledWith();
    expect(eventTarget.dispatchEvent).toHaveBeenCalledTimes(1);

    const failedTarget = { dispatchEvent: vi.fn(() => true) };
    await expect(sendWorkflowExperience(
      async () => { throw new Error("send failed"); },
      workflow.scenario.launch.starterMessage,
      workflow,
      failedTarget,
    )).rejects.toThrow("send failed");
    expect(failedTarget.dispatchEvent).not.toHaveBeenCalled();
  });

  it("普通消息不会推进工作流体验事件", async () => {
    const workflow = context("LOOP", "D0_CURRENT");
    const eventTarget = { dispatchEvent: vi.fn(() => true) };
    const send = vi.fn().mockResolvedValue(undefined);
    await sendWorkflowExperience(send, "普通问题", workflow, eventTarget);
    expect(eventTarget.dispatchEvent).not.toHaveBeenCalled();
  });
});
