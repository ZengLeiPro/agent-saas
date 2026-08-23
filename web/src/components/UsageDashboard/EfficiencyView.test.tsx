import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

function efficiencyReport(totalRuns = 37, tenantId = "tenant-a"): EfficiencyReport {
  return {
    range: { from: "2026-08-17T00:00:00.000Z", to: "2026-08-24T00:00:00.000Z", days: 7, bounds: "[from,to)" },
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

beforeEach(() => {
  vi.mocked(runTraceApi.efficiency).mockReset();
  vi.mocked(usageApi.trendByModel).mockReset();
  window.history.replaceState({}, "", "/");
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
});
