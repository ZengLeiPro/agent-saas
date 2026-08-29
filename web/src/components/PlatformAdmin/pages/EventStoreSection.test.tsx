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
      nextScheduledAt: null,
      watermarks: { legal: "100", billing: "200", effective: "180", maxGlobalSequence: "220", lag: "40" },
      categories: Object.fromEntries(["legal", "billing", "expired", "compacted", "orphaned", "other"].map((key, index) => [key, { eligible: index + 1, deleted: index }])),
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

  it("stale 即使最近成功也显示已过期和最近可信数据提示", () => {
    const data = fixture();
    data.retention.stale = true;
    data.capacity.stale = true;
    render(<EventStoreSection data={data} />);
    expect(screen.getAllByText("已过期").length).toBeGreaterThan(0);
    expect(screen.getByText(/当前显示最近一次可信数据/)).toBeTruthy();
  });

  it("容量样本不足显示暂无，不伪造趋势", () => {
    const data = fixture();
    data.capacity.series = data.capacity.series.slice(0, 1);
    render(<EventStoreSection data={data} />);
    expect(screen.getByText(/趋势：暂无（样本不足）/)).toBeTruthy();
  });

  it("容量不可用时总体健康降级为不可用", () => {
    const data = fixture();
    data.capacity.available = false;
    render(<EventStoreSection data={data} />);
    expect(screen.queryByText("健康")).toBeNull();
    expect(screen.getAllByText("不可用").length).toBeGreaterThan(0);
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

  it("null 数值显示破折号而不是 0", () => {
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
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(7);
    expect(screen.queryByText("0 B")).toBeNull();
    expect(screen.queryByText(/^0$/)).toBeNull();
  });
});
