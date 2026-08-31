import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { EventStoreRetentionStatus, EventStoreStatusResponse } from "../types";
import { EventStoreSection } from "./EventStoreSection";

function fixture(status: EventStoreRetentionStatus = "execute_succeeded"): EventStoreStatusResponse {
  return {
    schemaVersion: 1,
    available: true,
    generatedAt: "2026-08-29T14:00:00.000Z",
    retention: {
      enabled: true,
      mode: "execute",
      status,
      stale: false,
      lastStartedAt: "2026-08-29T13:00:00.000Z",
      lastCompletedAt: "2026-08-29T13:00:02.000Z",
      lastSuccessAt: "2026-08-29T13:00:02.000Z",
      durationMs: 2000,
      errorCategory: null,
      nextScheduledAt: "2026-08-29T14:10:00.000Z",
      watermarks: { legal: "180", billing: "200", effective: "180", maxGlobalSequence: "220", lag: "40" },
      categories: Object.fromEntries([
        "tool-delta",
        "assistant-stream",
        "tool-stream-summary",
        "model-diagnostics",
        "model-request-finished",
        "hand-events",
      ].map((key, index) => [key, { eligible: index + 1, deleted: index }])),
    },
    capacity: {
      available: true,
      tableName: "public.runtime_events",
      totalBytes: 3072,
      tableBytes: 2048,
      indexBytes: 1024,
      sampledAt: "2026-08-29T14:00:00.000Z",
      stale: false,
      series: [
        { totalBytes: 2048, tableBytes: 1024, indexBytes: 1024, sampledAt: "2026-08-29T13:00:00.000Z" },
        { totalBytes: 3072, tableBytes: 2048, indexBytes: 1024, sampledAt: "2026-08-29T14:00:00.000Z" },
      ],
    },
  };
}

describe("EventStoreSection", () => {
  it("展示健康状态、六类摘要、水位和 runtime_events 容量趋势", () => {
    render(<EventStoreSection data={fixture()} />);
    expect(screen.getAllByText("健康").length).toBeGreaterThan(0);
    expect(screen.getByText("execute")).toBeTruthy();
    expect(screen.getByText("执行成功")).toBeTruthy();
    expect(screen.getByText("public.runtime_events")).toBeTruthy();
    expect(screen.getByText(/趋势：总量/)).toBeTruthy();
    expect(screen.getAllByText(/eligible · deleted/)).toHaveLength(6);
  });

  it.each([
    ["never_run", "需关注", "text-warning-ink"],
    ["blocked", "已阻断", "text-destructive"],
    ["failed", "失败", "text-destructive"],
  ] as const)("%s 映射到 %s 且使用对应 tone", (status, text, toneClass) => {
    render(<EventStoreSection data={fixture(status)} />);
    expect(screen.getAllByText(text).some(node => node.className.includes(toneClass))).toBe(true);
  });

  it("已调度的当前模式在首轮完成前显示需关注", () => {
    const data = fixture("scheduled");
    data.retention.lastStartedAt = null;
    data.retention.lastCompletedAt = null;
    data.retention.durationMs = null;
    data.retention.watermarks.billing = null;
    data.retention.watermarks.effective = null;
    data.retention.watermarks.maxGlobalSequence = null;
    data.retention.watermarks.lag = null;
    data.retention.categories = {};
    render(<EventStoreSection data={data} />);
    expect(screen.getByText("已调度")).toBeTruthy();
    expect(screen.getAllByText("需关注").length).toBeGreaterThan(0);
    expect(screen.queryByText("健康")).toBeNull();
  });

  it("已调度状态携带运行进度时降级为不可用", () => {

    const data = fixture("scheduled");
    data.retention.lastStartedAt = null;
    data.retention.lastCompletedAt = null;
    data.retention.durationMs = null;
    data.retention.categories = {};
    data.retention.watermarks.billing = "1";
    data.retention.watermarks.effective = "1";
    data.retention.watermarks.maxGlobalSequence = "1";
    data.retention.watermarks.lag = "0";
    render(<EventStoreSection data={data} />);
    expect(screen.queryByText("健康")).toBeNull();
    expect(screen.getAllByText("不可用").length).toBeGreaterThan(0);
  });

  it("清理最高序号后仍以 lag=0 展示健康成功状态", () => {
    const data = fixture();
    data.retention.watermarks.maxGlobalSequence = "0";
    data.retention.watermarks.lag = "0";
    render(<EventStoreSection data={data} />);

    expect(screen.getAllByText("健康").length).toBeGreaterThan(0);
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
  });

  it.each([
    ["execute_succeeded", null, "执行成功"],
    ["failed", "execution_failed", "失败"],
    ["blocked", "authorization_missing", "已阻断"],
  ] as const)("过期 freshness 与最近 %s 结果正交展示", (status, errorCategory, resultText) => {
    const data = fixture(status);
    data.retention.stale = true;
    data.retention.errorCategory = errorCategory;
    render(<EventStoreSection data={data} />);

    expect(screen.getAllByText("已过期").length).toBeGreaterThan(0);
    const result = screen.getByText(resultText);
    expect(result).toBeTruthy();
    expect(screen.getByText(/当前显示最近一次可信数据/)).toBeTruthy();
    if (errorCategory) {
      expect(result.className).toContain("text-destructive");
      expect(screen.getByText(new RegExp(`错误类别 ${errorCategory}`))).toBeTruthy();
    }
  });

  it.each([0, 1])("容量只有 %i 个有效样本时降级为需关注，不伪造绿色趋势", (sampleCount) => {
    const data = fixture();
    data.capacity.series = data.capacity.series.slice(0, sampleCount);
    render(<EventStoreSection data={data} />);
    expect(screen.queryByText("健康")).toBeNull();
    expect(screen.getAllByText("需关注").length).toBeGreaterThan(0);
    expect(screen.getByText(/趋势：暂无（样本不足）/)).toBeTruthy();
    expect(screen.getByText(/有效样本不足 2 条/)).toBeTruthy();
  });

  it.each([
    ["缺失成功时间", (data: EventStoreStatusResponse) => { data.retention.lastSuccessAt = null; }],
    ["非法完成时间", (data: EventStoreStatusResponse) => { data.retention.lastCompletedAt = "not-a-time"; }],
    ["未来成功时间", (data: EventStoreStatusResponse) => { data.retention.lastSuccessAt = "2099-01-01T00:00:00.000Z"; }],
    ["负耗时", (data: EventStoreStatusResponse) => { data.retention.durationMs = -1; }],
    ["水位缺失", (data: EventStoreStatusResponse) => { data.retention.watermarks.billing = null; }],
    ["effective 不是双水位最小值", (data: EventStoreStatusResponse) => { data.retention.watermarks.effective = "179"; }],
    ["lag 不一致", (data: EventStoreStatusResponse) => { data.retention.watermarks.lag = "41"; }],
    ["空分类", (data: EventStoreStatusResponse) => { data.retention.categories = {}; }],
    ["模式与状态不一致", (data: EventStoreStatusResponse) => { data.retention.mode = "dry-run"; }],
    ["dry-run 出现删除量", (data: EventStoreStatusResponse) => {
      data.retention.status = "dry_run_succeeded";
      data.retention.mode = "dry-run";
    }],
  ])("成功 retention 状态%s时不得显示绿色健康", (_name, mutate) => {
    const data = fixture();
    mutate(data);
    render(<EventStoreSection data={data} />);
    expect(screen.queryByText("健康")).toBeNull();
    expect(screen.getAllByText("不可用").length).toBeGreaterThan(0);
  });

  it.each([
    ["缺三分量", { totalBytes: 100, tableBytes: null, indexBytes: null, sampledAt: "2026-08-29T13:30:00.000Z" }],
    ["负数", { totalBytes: 100, tableBytes: 101, indexBytes: -1, sampledAt: "2026-08-29T13:30:00.000Z" }],
    ["总量小于表与索引和", { totalBytes: 150, tableBytes: 100, indexBytes: 60, sampledAt: "2026-08-29T13:30:00.000Z" }],
    ["非法时间", { totalBytes: 100, tableBytes: 60, indexBytes: 40, sampledAt: "not-a-time" }],
  ])("容量历史窗口夹杂%s样本时整体降级为不可用", (_name, invalidSample) => {
    const data = fixture();
    data.capacity.series = [data.capacity.series[0]!, invalidSample, data.capacity.series[1]!];
    render(<EventStoreSection data={data} />);
    expect(screen.queryByText("健康")).toBeNull();
    expect(screen.getAllByText("不可用").length).toBeGreaterThan(0);
    expect(screen.getByText("容量不可用")).toBeTruthy();
  });

  it("容量不可用时总体健康降级为不可用", () => {
    const data = fixture();
    data.capacity.available = false;
    render(<EventStoreSection data={data} />);
    expect(screen.queryByText("健康")).toBeNull();
    expect(screen.getAllByText("不可用").length).toBeGreaterThan(0);
    expect(screen.getByText("容量不可用")).toBeTruthy();
  });

  it("容量过期时总体健康降级为已过期", () => {
    const data = fixture();
    data.capacity.stale = true;
    render(<EventStoreSection data={data} />);
    expect(screen.queryByText("健康")).toBeNull();
    expect(screen.getAllByText("已过期").some(node => node.className.includes("text-warning-ink"))).toBe(true);
  });

  it("刷新失败保留可信值但总体健康降级为已过期", () => {
    render(<EventStoreSection data={fixture()} refreshFailed />);
    expect(screen.queryByText("健康")).toBeNull();
    expect(screen.getAllByText("已过期").length).toBeGreaterThan(0);
    expect(screen.getByText(/刷新失败；当前显示最近一次可信数据/)).toBeTruthy();
  });

  it("未知 retention status 不会显示为健康", () => {
    const data = fixture();
    (data.retention as { status: string }).status = "future_status";
    render(<EventStoreSection data={data} />);
    expect(screen.queryByText("健康")).toBeNull();
    expect(screen.getAllByText("不可用").length).toBeGreaterThan(0);
  });

  it("旧格式新鲜容量最新样本含 null 时显示不可用，绝不显示绿色健康或 0", () => {
    const data = fixture();
    data.retention.durationMs = null;
    data.retention.watermarks.billing = null;
    data.retention.watermarks.effective = null;
    data.retention.watermarks.lag = null;
    data.retention.categories = { legal: { eligible: null, deleted: null } };
    data.capacity.tableBytes = null;
    data.capacity.indexBytes = null;
    data.capacity.totalBytes = null;
    data.capacity.series = [];
    render(<EventStoreSection data={data} />);
    expect(screen.queryByText("健康")).toBeNull();
    expect(screen.getAllByText("不可用").length).toBeGreaterThan(0);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("0 B")).toBeNull();
    expect(screen.queryByText(/^0$/)).toBeNull();
  });
});
