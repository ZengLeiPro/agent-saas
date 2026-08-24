import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EfficiencyReport } from "@/components/RunTraceExplorer/types";
import type { ModelTrendResp } from "./types";

import { runTraceApi } from "@/components/RunTraceExplorer/api";
import { EfficiencyView } from "./EfficiencyView";
import { usageApi } from "./api";

vi.mock("@/components/RunTraceExplorer/api", () => ({
  runTraceApi: { efficiency: vi.fn() },
}));

vi.mock("./api", () => ({
  usageApi: { trendByModel: vi.fn() },
}));

vi.mock("@/components/TenantAnalytics/hooks", () => ({
  useModelDisplayMap: () => ({ labelFor: (model: string) => model }),
}));

vi.mock("@/components/PlatformAdmin/ToolAnalysisPanel", () => ({
  ToolAnalysisPanel: () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function efficiencyReport(
  totalRuns = 37,
  tenantId = "tenant-a",
  range: EfficiencyReport["range"] = {
    from: "2026-08-17T16:00:00.000Z",
    to: "2026-08-24T16:00:00.000Z",
    days: 7,
    bounds: "[from,to)",
  },
): EfficiencyReport {
  return {
    range,
    tenantId,
    statistics: {
      version: "runtime-runs-requested-at-v1",
      source: "runtime_runs",
      identity: "run_id",
      initiatedAt: "requested_at",
      dataAsOf: "2026-08-24T00:00:00.000Z",
      completionDefinition: "completed / initiated",
      longRunningDefinition: "non_terminal_started_for_24h",
    },
    outcome: {
      totalRuns,
      success: totalRuns,
      error: 0,
      interrupted: 0,
      nonTerminal: 0,
      completionRate: 1,
      errorReasons: [],
    },
    tools: { byTool: [], handFailures: 0 },
    cost: { byModel: [], cacheHitRate: null },
    longTail: { slowestRuns: [], longRunningRuns: [], mostTurns: [] },
    approvals: { count: 0, resolvedCount: 0, waitP50Ms: null, waitP90Ms: null, byTool: [] },
    waste: {
      duplicateToolCalls: { affectedRuns: 0, totalDuplicateCalls: 0, topOffenders: [] },
      repeatedFileReads: { affectedRuns: 0, topFiles: [] },
      unmodifiedRetries: { count: 0, byTool: [] },
    },
    costRedacted: true,
  };
}

function emptyTrend(): ModelTrendResp {
  return {
    fromDate: "2026-08-18",
    toDate: "2026-08-24",
    range: "custom",
    username: null,
    tenantId: "tenant-a",
    family: null,
    points: [],
  };
}

function modelTrend(model: string, date = "2026-08-24"): ModelTrendResp {
  return {
    ...emptyTrend(),
    fromDate: date,
    toDate: date,
    points: [{
      date,
      models: [{
        model,
        totalTokens: 1234,
        totalTurns: 1,
        inputTokens: 1000,
        outputTokens: 234,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }],
    }],
  };
}

beforeEach(() => {
  vi.mocked(runTraceApi.efficiency).mockReset();
  vi.mocked(usageApi.trendByModel).mockReset();
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EfficiencyView request windows", () => {
  it.each([
    { days: 7, trendFrom: "2026-08-18", trendTo: "2026-08-24", efficiencyFrom: "2026-08-17T16:00:00.000Z", efficiencyTo: "2026-08-24T16:00:00.000Z" },
    { days: 14, trendFrom: "2026-08-11", trendTo: "2026-08-24", efficiencyFrom: "2026-08-10T16:00:00.000Z", efficiencyTo: "2026-08-24T16:00:00.000Z" },
    { days: 30, trendFrom: "2026-07-26", trendTo: "2026-08-24", efficiencyFrom: "2026-07-25T16:00:00.000Z", efficiencyTo: "2026-08-24T16:00:00.000Z" },
  ])("derives matching trend and efficiency boundaries for $days days", async ({
    days,
    trendFrom,
    trendTo,
    efficiencyFrom,
    efficiencyTo,
  }) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-23T22:14:00.000Z"));
    vi.mocked(runTraceApi.efficiency).mockResolvedValueOnce(efficiencyReport(37, "tenant-a", {
      from: efficiencyFrom,
      to: efficiencyTo,
      days,
      bounds: "[from,to)",
    }));
    vi.mocked(usageApi.trendByModel).mockResolvedValueOnce(emptyTrend());
    window.history.replaceState({}, "", `/?effDays=${days}`);

    render(<EfficiencyView tenantId="tenant-a" linkEntities={false} />);

    await waitFor(() => {
      expect(runTraceApi.efficiency).toHaveBeenCalledTimes(1);
      expect(usageApi.trendByModel).toHaveBeenCalledTimes(1);
    });
    expect(runTraceApi.efficiency).toHaveBeenCalledWith({
      days,
      tenantId: "tenant-a",
      from: efficiencyFrom,
      to: efficiencyTo,
    });
    expect(usageApi.trendByModel).toHaveBeenCalledWith({
      from: trendFrom,
      to: trendTo,
      tenantId: "tenant-a",
    });
    expect(screen.getByText(`${trendFrom} → ${trendTo}`)).toBeTruthy();

    const efficiencyRequest = vi.mocked(runTraceApi.efficiency).mock.calls[0][0];
    const trendRequest = vi.mocked(usageApi.trendByModel).mock.calls[0][0];
    const trendDayAfter = new Date(Date.parse(`${trendRequest.to}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(efficiencyRequest.from).toBe(new Date(`${trendRequest.from}T00:00:00+08:00`).toISOString());
    expect(efficiencyRequest.to).toBe(new Date(`${trendDayAfter}T00:00:00+08:00`).toISOString());
  });

  it("clears the previous natural-day window when refreshing across Beijing midnight", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-24T15:59:00.000Z"));
    const nextEfficiency = deferred<EfficiencyReport>();
    const nextTrend = deferred<ModelTrendResp>();
    vi.mocked(runTraceApi.efficiency)
      .mockResolvedValueOnce(efficiencyReport(24))
      .mockReturnValueOnce(nextEfficiency.promise);
    vi.mocked(usageApi.trendByModel)
      .mockResolvedValueOnce(modelTrend("before-midnight-model"))
      .mockReturnValueOnce(nextTrend.promise);

    render(<EfficiencyView tenantId="tenant-a" linkEntities={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "隐藏 before-midnight-model" })).toBeTruthy());
    expect(screen.getByText("24")).toBeTruthy();

    nowSpy.mockReturnValue(Date.parse("2026-08-24T16:01:00.000Z"));
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    expect(screen.queryByRole("button", { name: "隐藏 before-midnight-model" })).toBeNull();
    expect(screen.queryByText("24")).toBeNull();
    expect(screen.getByText("加载效率数据...")).toBeTruthy();
    expect(runTraceApi.efficiency).toHaveBeenLastCalledWith({
      days: 7,
      tenantId: "tenant-a",
      from: "2026-08-18T16:00:00.000Z",
      to: "2026-08-25T16:00:00.000Z",
    });
    expect(usageApi.trendByModel).toHaveBeenLastCalledWith({
      from: "2026-08-19",
      to: "2026-08-25",
      tenantId: "tenant-a",
    });

    await act(async () => nextTrend.resolve(modelTrend("after-midnight-model", "2026-08-25")));
    await waitFor(() => expect(screen.getByRole("button", { name: "隐藏 after-midnight-model" })).toBeTruthy());
    expect(screen.getByText("加载效率数据...")).toBeTruthy();

    await act(async () => nextEfficiency.reject(new Error("午夜后效率失败")));
    await waitFor(() => expect(document.body.textContent).toContain("午夜后效率失败"));
    expect(screen.queryByText("24")).toBeNull();
    expect(screen.getByRole("button", { name: "隐藏 after-midnight-model" })).toBeTruthy();
  });
});

describe("EfficiencyView request states", () => {
  it("shows efficiency as soon as it resolves while the model trend is still pending", async () => {
    const efficiency = deferred<EfficiencyReport>();
    const trend = deferred<ModelTrendResp>();
    vi.mocked(runTraceApi.efficiency).mockReturnValueOnce(efficiency.promise);
    vi.mocked(usageApi.trendByModel).mockReturnValueOnce(trend.promise);

    render(<EfficiencyView tenantId="tenant-a" linkEntities={false} />);

    await act(async () => efficiency.resolve(efficiencyReport()));

    await waitFor(() => expect(screen.getByText("37")).toBeTruthy());
    expect(screen.queryByText("加载效率数据...")).toBeNull();
    expect(screen.getByText("正在加载模型趋势…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "刷新" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => trend.resolve(emptyTrend()));

    await waitFor(() => expect(screen.getByText("所选区间内暂无模型 Token 用量")).toBeTruthy());
    expect(screen.getByText("37")).toBeTruthy();
  });

  it("keeps the efficiency page visible when the independently settling trend request fails", async () => {
    const trend = deferred<ModelTrendResp>();
    vi.mocked(runTraceApi.efficiency).mockResolvedValueOnce(efficiencyReport(41));
    vi.mocked(usageApi.trendByModel).mockReturnValueOnce(trend.promise);

    render(<EfficiencyView tenantId="tenant-a" linkEntities={false} />);

    await waitFor(() => expect(screen.getByText("41")).toBeTruthy());
    expect(screen.getByText("正在加载模型趋势…")).toBeTruthy();

    await act(async () => trend.reject(new Error("趋势超时")));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("模型趋势加载失败：趋势超时"));
    expect(screen.getByText("41")).toBeTruthy();
    expect(screen.queryByText("加载效率数据...")).toBeNull();
  });

  it("does not clear existing efficiency data while a refresh is in flight", async () => {
    vi.mocked(runTraceApi.efficiency).mockResolvedValueOnce(efficiencyReport());
    vi.mocked(usageApi.trendByModel).mockResolvedValueOnce(emptyTrend());
    const refreshedEfficiency = deferred<EfficiencyReport>();
    const refreshedTrend = deferred<ModelTrendResp>();
    vi.mocked(runTraceApi.efficiency).mockReturnValueOnce(refreshedEfficiency.promise);
    vi.mocked(usageApi.trendByModel).mockReturnValueOnce(refreshedTrend.promise);

    render(<EfficiencyView tenantId="tenant-a" linkEntities={false} />);
    await waitFor(() => expect(screen.getByText("37")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    expect(screen.getByText("37")).toBeTruthy();
    expect(screen.queryByText("加载效率数据...")).toBeNull();
    expect(screen.getByLabelText("正在刷新模型趋势")).toBeTruthy();

    await act(async () => {
      refreshedEfficiency.resolve(efficiencyReport(42));
      refreshedTrend.resolve(emptyTrend());
    });
    await waitFor(() => expect(screen.getByText("42")).toBeTruthy());
  });

  it("hides the previous tenant immediately and ignores its late responses", async () => {
    const tenantAEfficiency = deferred<EfficiencyReport>();
    const tenantATrend = deferred<ModelTrendResp>();
    const tenantBEfficiency = deferred<EfficiencyReport>();
    const tenantBTrend = deferred<ModelTrendResp>();
    vi.mocked(runTraceApi.efficiency)
      .mockReturnValueOnce(tenantAEfficiency.promise)
      .mockReturnValueOnce(tenantBEfficiency.promise);
    vi.mocked(usageApi.trendByModel)
      .mockReturnValueOnce(tenantATrend.promise)
      .mockReturnValueOnce(tenantBTrend.promise);

    const { rerender } = render(<EfficiencyView tenantId="tenant-a" linkEntities={false} />);
    rerender(<EfficiencyView tenantId="tenant-b" linkEntities={false} />);

    await act(async () => {
      tenantAEfficiency.resolve(efficiencyReport(37, "tenant-a"));
      tenantATrend.resolve(emptyTrend());
    });
    expect(screen.queryByText("37")).toBeNull();

    await act(async () => tenantBEfficiency.resolve(efficiencyReport(52, "tenant-b")));
    await waitFor(() => expect(screen.getByText("52")).toBeTruthy());
    expect(screen.queryByText("37")).toBeNull();

    await act(async () => tenantBTrend.resolve(emptyTrend()));
  });

  it("shows the model trend as soon as it resolves while efficiency is still pending", async () => {
    const efficiency = deferred<EfficiencyReport>();
    const trend = deferred<ModelTrendResp>();
    vi.mocked(runTraceApi.efficiency).mockReturnValueOnce(efficiency.promise);
    vi.mocked(usageApi.trendByModel).mockReturnValueOnce(trend.promise);

    render(<EfficiencyView tenantId="tenant-a" linkEntities={false} />);
    await act(async () => trend.resolve(modelTrend("trend-before-efficiency")));

    await waitFor(() => expect(screen.getByRole("button", { name: "隐藏 trend-before-efficiency" })).toBeTruthy());
    expect(screen.getByText("加载效率数据...")).toBeTruthy();

    await act(async () => efficiency.resolve(efficiencyReport()));
  });

  it.each([
    ["404", "/trend-by-model → 404", "模型趋势数据源未启用"],
    ["failure", "趋势服务失败", "模型趋势加载失败：趋势服务失败"],
  ])("keeps the trend %s state visible when efficiency also fails", async (_kind, trendReason, expectedTrendText) => {
    vi.mocked(runTraceApi.efficiency).mockRejectedValueOnce(new Error("效率服务失败"));
    vi.mocked(usageApi.trendByModel).mockRejectedValueOnce(new Error(trendReason));

    render(<EfficiencyView tenantId="tenant-a" linkEntities={false} />);

    await waitFor(() => expect(screen.getByText(expectedTrendText)).toBeTruthy());
    expect(document.body.textContent).toContain("效率服务失败");
    expect(screen.queryByText("加载效率数据...")).toBeNull();
  });

  it("hides 7-day data immediately on a 30-day switch and ignores late 7-day refreshes", async () => {
    vi.mocked(runTraceApi.efficiency).mockResolvedValueOnce(efficiencyReport(7));
    vi.mocked(usageApi.trendByModel).mockResolvedValueOnce(modelTrend("seven-day-model"));
    const refreshedSevenEfficiency = deferred<EfficiencyReport>();
    const refreshedSevenTrend = deferred<ModelTrendResp>();
    const thirtyEfficiency = deferred<EfficiencyReport>();
    const thirtyTrend = deferred<ModelTrendResp>();
    vi.mocked(runTraceApi.efficiency)
      .mockReturnValueOnce(refreshedSevenEfficiency.promise)
      .mockReturnValueOnce(thirtyEfficiency.promise);
    vi.mocked(usageApi.trendByModel)
      .mockReturnValueOnce(refreshedSevenTrend.promise)
      .mockReturnValueOnce(thirtyTrend.promise);

    render(<EfficiencyView tenantId="tenant-a" linkEntities={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "隐藏 seven-day-model" })).toBeTruthy());
    expect(screen.getByText("7")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(screen.getByRole("button", { name: "隐藏 seven-day-model" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "30 天" }));

    expect(screen.queryByRole("button", { name: "隐藏 seven-day-model" })).toBeNull();
    expect(screen.queryByText("7")).toBeNull();
    expect(screen.getByText("加载效率数据...")).toBeTruthy();

    await act(async () => thirtyTrend.resolve(modelTrend("thirty-day-model", "2026-08-01")));
    await waitFor(() => expect(screen.getByRole("button", { name: "隐藏 thirty-day-model" })).toBeTruthy());
    expect(screen.getByText("加载效率数据...")).toBeTruthy();

    await act(async () => {
      refreshedSevenEfficiency.resolve(efficiencyReport(17));
      refreshedSevenTrend.resolve(modelTrend("late-seven-day-model"));
    });
    expect(screen.queryByText("17")).toBeNull();
    expect(screen.queryByRole("button", { name: "隐藏 late-seven-day-model" })).toBeNull();
    expect(screen.getByRole("button", { name: "隐藏 thirty-day-model" })).toBeTruthy();

    await act(async () => thirtyEfficiency.resolve(efficiencyReport(30)));
    await waitFor(() => expect(screen.getByText("30")).toBeTruthy());
  });

  it("does not retain the 7-day trend when the 30-day trend request fails", async () => {
    vi.mocked(runTraceApi.efficiency)
      .mockResolvedValueOnce(efficiencyReport(7))
      .mockResolvedValueOnce(efficiencyReport(30));
    vi.mocked(usageApi.trendByModel)
      .mockResolvedValueOnce(modelTrend("seven-day-only"))
      .mockRejectedValueOnce(new Error("30 天趋势失败"));

    render(<EfficiencyView tenantId="tenant-a" linkEntities={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "隐藏 seven-day-only" })).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: "30 天" }));

    await waitFor(() => expect(screen.getByText("模型趋势加载失败：30 天趋势失败")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "隐藏 seven-day-only" })).toBeNull();
    expect(screen.getByText("30")).toBeTruthy();
    expect(screen.queryByText("7")).toBeNull();
  });
});
