import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScenarioItem } from "@agent/shared";

import { CronCreationWizard } from "./CronCreationWizard";
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
});
