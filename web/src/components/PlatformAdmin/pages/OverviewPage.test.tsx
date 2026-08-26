import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverviewPage } from "./OverviewPage";

const overviewSnapshot = vi.fn();
const billingTrend = vi.fn();
const overviewTrends = vi.fn();

vi.mock("../api", () => ({
  platformAdminApi: {
    overviewSnapshot: (...args: unknown[]) => overviewSnapshot(...args),
    billingTrend: (...args: unknown[]) => billingTrend(...args),
    overviewTrends: (...args: unknown[]) => overviewTrends(...args),
  },
}));

const snapshot = {
  generatedAt: "2026-08-26T17:00:00.000Z",
  health: {
    activeRuns: { total: 3, byStatus: { running: 3 } },
    sandboxes: { total: 2, running: 2, paused: 0, broken: 0 },
    todayCostYuan: 1.25,
    todayRuns: 4,
    completionRateToday: 1,
    toolRouting24h: { total: 5, acsCount: 5, localCount: 0, failedCount: 0 },
    dispatch: null,
    sessionMetaProjection: null,
    handFailures1h: 0,
    storage: null,
  },
  attention: [],
};

describe("平台概览站内链接", () => {
  beforeEach(() => {
    window.history.replaceState(
      { analysisWorkspace: { source: "/chat/session-1", depth: 1 } },
      "",
      "/platform-console/overview/overview",
    );
    overviewSnapshot.mockReset().mockResolvedValue(snapshot);
    billingTrend.mockReset().mockResolvedValue({ audit: { days: 14, daily: [] } });
    overviewTrends.mockReset().mockResolvedValue({
      available: true,
      missingSources: [],
      days: 14,
      timezone: "Asia/Shanghai",
      daily: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("普通左键使用 SPA 导航并继承分析来源", async () => {
    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);
    render(<OverviewPage />);

    const link = await screen.findByRole("link", { name: "3 条执行记录" });
    expect(link.getAttribute("href")).toBe("/platform-admin/runs?status=active");
    await userEvent.click(link);

    expect(`${window.location.pathname}${window.location.search}`)
      .toBe("/platform-admin/runs?status=active");
    expect(window.history.state.analysisWorkspace).toEqual({ source: "/chat/session-1", depth: 2 });
    expect(popstate).toHaveBeenCalledOnce();
    window.removeEventListener("popstate", popstate);
  });

  it("修饰键点击保留原生链接行为，不改写当前分析历史", async () => {
    render(<OverviewPage />);

    const link = await screen.findByRole("link", { name: "3 条执行记录" });
    document.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(link, { ctrlKey: true });
    expect(`${window.location.pathname}${window.location.search}`)
      .toBe("/platform-console/overview/overview");
    expect(window.history.state.analysisWorkspace).toEqual({ source: "/chat/session-1", depth: 1 });
  });
});
