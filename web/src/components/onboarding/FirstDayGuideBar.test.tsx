import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FirstDayGuideBar, guideReducer } from "./FirstDayGuideBar";

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
});
