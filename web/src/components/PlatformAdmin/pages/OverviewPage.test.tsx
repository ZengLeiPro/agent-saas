import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("StrictMode effect 重放会发起新的 snapshot 请求而不是复用已取消请求", async () => {
    render(<StrictMode><OverviewPage /></StrictMode>);

    expect(await screen.findByText("暂无待处理异常")).toBeTruthy();
    expect(overviewSnapshot).toHaveBeenCalledTimes(2);
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

  it("成功获取空队列后手动刷新失败，不把旧快照渲染为正常", async () => {
    overviewSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new Error("refresh failed"));
    render(<OverviewPage />);

    expect(await screen.findByText("暂无待处理异常")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    expect(await screen.findByText(/当前展示的是上次成功获取的数据（已过期）/)).toBeTruthy();
    expect(screen.getByText("异常检查暂不可用，无法确认当前是否有异常")).toBeTruthy();
    expect(screen.queryByText("暂无待处理异常")).toBeNull();
    expect(screen.getByText("数据已过期")).not.toBeNull();
    expect(screen.queryByText("当前没有正在执行或等待中的任务")).toBeNull();
  });

  it("定时刷新失败时将快照标记为已过期", async () => {
    vi.useFakeTimers();
    overviewSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new Error("poll failed"));
    render(<OverviewPage />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("暂无待处理异常")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(screen.getByText(/当前展示的是上次成功获取的数据（已过期）/)).toBeTruthy();
    expect(screen.getByText("异常检查暂不可用，无法确认当前是否有异常")).toBeTruthy();
    expect(screen.queryByText("暂无待处理异常")).toBeNull();
  });

  it("已成功空队列后的悬挂刷新超时会过期，且迟到成功不能恢复 fresh", async () => {
    vi.useFakeTimers();
    const lateSnapshot = deferred<typeof snapshot>();
    overviewSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockReturnValueOnce(lateSnapshot.promise);
    render(<OverviewPage />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("暂无待处理异常")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText(/当前展示的是上次成功获取的数据（已过期）/)).toBeTruthy();
    expect(screen.queryByText("暂无待处理异常")).toBeNull();
    expect(screen.queryByText("正常")).toBeNull();

    await act(async () => {
      lateSnapshot.resolve(snapshot);
      await Promise.resolve();
    });
    expect(screen.getByText(/当前展示的是上次成功获取的数据（已过期）/)).toBeTruthy();
    expect(screen.queryByText("暂无待处理异常")).toBeNull();
    expect(screen.queryByText("正常")).toBeNull();
  });

  it("自动轮询等待当前请求结束，不启动重叠请求", async () => {
    vi.useFakeTimers();
    const pendingSnapshot = deferred<typeof snapshot>();
    overviewSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockReturnValueOnce(pendingSnapshot.promise);
    render(<OverviewPage />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(overviewSnapshot).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(overviewSnapshot).toHaveBeenCalledTimes(2);
  });

  it("趋势辅助请求悬挂时 snapshot 仍立即进入 fresh", async () => {
    billingTrend.mockReturnValueOnce(deferred<never>().promise);
    render(<OverviewPage />);

    expect(await screen.findByText("暂无待处理异常")).toBeTruthy();
    expect(screen.queryByText(/总览数据不可用|当前展示的是上次成功获取的数据/)).toBeNull();
  });

  it("趋势辅助请求悬挂时不阻塞后续手动和自动刷新", async () => {
    vi.useFakeTimers();
    const hangingTrend = deferred<never>();
    let firstTrendSignal: AbortSignal | undefined;
    billingTrend.mockImplementationOnce((_days: number, signal: AbortSignal) => {
      firstTrendSignal = signal;
      return hangingTrend.promise;
    });
    overviewTrends.mockReturnValueOnce(hangingTrend.promise);
    render(<OverviewPage />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(overviewSnapshot).toHaveBeenCalledTimes(1);
    expect(screen.getByText("暂无待处理异常")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(overviewSnapshot).toHaveBeenCalledTimes(2);
    expect(firstTrendSignal?.aborted).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(overviewSnapshot).toHaveBeenCalledTimes(3);
  });

  it("首次加载悬挂超时后明确标记 unavailable", async () => {
    vi.useFakeTimers();
    const pendingSnapshot = deferred<typeof snapshot>();
    let requestSignal: AbortSignal | undefined;
    overviewSnapshot.mockImplementationOnce((signal: AbortSignal) => {
      requestSignal = signal;
      return pendingSnapshot.promise;
    });
    render(<OverviewPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(screen.getByText("总览数据不可用，无法判断当前平台状态。")).toBeTruthy();
    expect(screen.getByText("异常检查暂不可用，无法确认当前是否有异常")).toBeTruthy();
    expect(screen.queryByText("暂无待处理异常")).toBeNull();
    expect(screen.queryByText("正常")).toBeNull();
  });

  it("首次加载失败时明确标记总览和异常队列不可用", async () => {
    overviewSnapshot.mockRejectedValueOnce(new Error("initial failed"));
    render(<OverviewPage />);

    expect(await screen.findByText("总览数据不可用，无法判断当前平台状态。")).toBeTruthy();
    expect(screen.getByText("异常检查暂不可用，无法确认当前是否有异常")).toBeTruthy();
    expect(screen.getByText("数据不可用")).toBeTruthy();
    expect(screen.queryByText("暂无待处理异常")).toBeNull();
    expect(screen.queryByText("正常")).toBeNull();
  });
});
