import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ModelTokenTrendCard, prepareModelTrend } from "./ModelTokenTrendChart";
import type { ModelAggregate, ModelTrendPoint, ModelTrendResp } from "./types";

function model(modelName: string, totalTokens: number, totalCostUsd?: number): ModelAggregate {
  return {
    model: modelName,
    totalTokens,
    totalCostUsd,
    totalTurns: 1,
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

const POINTS: ModelTrendPoint[] = [
  {
    date: "2026-08-22",
    models: [
      model("model-a", 60),
      model("model-b", 50),
      model("model-c", 40),
      model("model-d", 30),
      model("model-e", 20),
      model("model-f", 10),
      model("model-g", 7),
      model("model-h", 3),
    ],
  },
  {
    date: "2026-08-23",
    models: [
      model("model-a", 6),
      model("model-b", 5),
      model("model-c", 4),
      model("model-d", 3),
      model("model-e", 2),
      model("model-f", 1),
      model("model-g", 2),
      model("model-h", 1),
    ],
  },
];

describe("prepareModelTrend", () => {
  it("keeps the interval Top 6 and conserves every day's tokens in 其他模型（聚合）", () => {
    const result = prepareModelTrend(POINTS);

    expect(result.series.map((series) => series.label)).toEqual([
      "model-a",
      "model-b",
      "model-c",
      "model-d",
      "model-e",
      "model-f",
      "其他模型（聚合）",
    ]);
    expect(result.points.map((point) => point.totalTokens)).toEqual([220, 24]);
    expect(result.points[0].segments.find((segment) => segment.key === "other")?.tokens).toBe(10);
    expect(result.points[1].segments.find((segment) => segment.key === "other")?.tokens).toBe(3);
    expect(result.points.every((point) => (
      point.segments.reduce((sum, segment) => sum + segment.tokens, 0) === point.totalTokens
    ))).toBe(true);
  });

  it("keeps colliding model and other keys unique while conserving tokens", () => {
    const result = prepareModelTrend([{
      date: "2026-08-24",
      models: [
        model("__other_models__", 70),
        model("model-a", 60),
        model("model-b", 50),
        model("model-c", 40),
        model("model-d", 30),
        model("model-e", 20),
        model("model-f", 10),
      ],
    }]);
    const keys = result.series.map((series) => series.key);
    const segments = result.points[0].segments;

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(segments.map((segment) => segment.key)).size).toBe(segments.length);
    expect(segments.reduce((sum, segment) => sum + segment.tokens, 0)).toBe(280);
    expect(segments.find((segment) => segment.key === "model:__other_models__")?.tokens).toBe(70);
    expect(segments.find((segment) => segment.key === "other")?.tokens).toBe(10);
  });

  it("assigns each interval model the same deterministic color regardless of date order", () => {
    const forward = prepareModelTrend(POINTS);
    const reversed = prepareModelTrend([...POINTS].reverse());

    expect(Object.fromEntries(forward.series.map((series) => [series.key, series.color])))
      .toEqual(Object.fromEntries(reversed.series.map((series) => [series.key, series.color])));
  });
});

describe("ModelTokenTrendCard", () => {
  it("exposes date/model/token/share/cost semantics and lets the legend hide a model", () => {
    const response: ModelTrendResp = {
      fromDate: "2026-08-23",
      toDate: "2026-08-23",
      range: "custom",
      username: null,
      tenantId: null,
      family: null,
      points: [{
        date: "2026-08-23",
        models: [model("model-a", 75, 0.1), model("model-b", 25, 0.02)],
      }],
    };

    render(
      <ModelTokenTrendCard
        response={response}
        loading={false}
        error={null}
        labelFor={(name) => name === "model-a" ? "Alpha" : "Beta"}
      />,
    );

    const chart = screen.getByRole("group", { name: "按北京时间自然日统计的模型 Token 用量趋势" });
    const svg = chart.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    expect(within(chart).queryByRole("img")).toBeNull();
    const details = within(chart).getByRole("list", { name: "模型 Token 用量明细" });
    expect(details.className).toContain("focus-within:not-sr-only");
    const alphaDescription = "2026-08-23 · Alpha · Token 75 · 占比 75.0% · 输入 75 · 输出 0 · 缓存读 0 · 缓存写 0 · 轮次 1 · 成本 $0.1000";
    const alphaItem = within(details).getByRole("listitem", { name: alphaDescription });
    expect(alphaItem.textContent).toBe(alphaDescription);
    expect(alphaItem.getAttribute("tabindex")).toBe("0");
    expect(within(details).getAllByRole("listitem")).toHaveLength(2);

    const legend = within(chart).getByRole("button", { name: "隐藏 Alpha" });
    expect(legend.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(legend);

    expect(within(chart).getByRole("button", { name: "显示 Alpha" }).getAttribute("aria-pressed")).toBe("false");
    expect(within(details).queryByRole("listitem", { name: alphaDescription })).toBeNull();
    expect(within(details).getAllByRole("listitem")).toHaveLength(1);
  });

  it("distinguishes a real model label from the aggregate series in legends and details", () => {
    const response: ModelTrendResp = {
      fromDate: "2026-08-24",
      toDate: "2026-08-24",
      range: "custom",
      username: null,
      tenantId: null,
      family: null,
      points: [{
        date: "2026-08-24",
        models: [
          model("model-other", 70),
          model("model-a", 60),
          model("model-b", 50),
          model("model-c", 40),
          model("model-d", 30),
          model("model-e", 20),
          model("model-f", 10),
        ],
      }],
    };

    render(
      <ModelTokenTrendCard
        response={response}
        loading={false}
        error={null}
        labelFor={(name) => name === "model-other" ? "其他模型（聚合）" : name}
      />,
    );

    const chart = screen.getByRole("group", { name: "按北京时间自然日统计的模型 Token 用量趋势" });
    const details = within(chart).getByRole("list", { name: "模型 Token 用量明细" });
    const detailText = within(details).getAllByRole("listitem").map((item) => item.textContent);
    const tooltipText = [...chart.querySelectorAll("title")].map((title) => title.textContent);

    expect(within(chart).getByRole("button", { name: "隐藏 其他模型（聚合）（单一模型）" })).toBeTruthy();
    const aggregateLegend = within(chart).getByRole("button", { name: "隐藏 其他模型（聚合）" });
    expect(detailText.some((text) => text?.includes("其他模型（聚合）（单一模型） · Token 70"))).toBe(true);
    expect(detailText.some((text) => text?.includes("其他模型（聚合） · Token 10"))).toBe(true);
    expect(tooltipText.some((text) => text?.includes("其他模型（聚合）（单一模型） · Token 70"))).toBe(true);
    expect(tooltipText.some((text) => text?.includes("其他模型（聚合） · Token 10"))).toBe(true);

    fireEvent.click(aggregateLegend);

    expect(within(chart).getByRole("button", { name: "显示 其他模型（聚合）" })).toBeTruthy();
    const remainingDetails = within(details).getAllByRole("listitem").map((item) => item.textContent);
    const remainingTooltips = [...chart.querySelectorAll("title")].map((title) => title.textContent);
    expect(remainingDetails.some((text) => text?.includes("其他模型（聚合）（单一模型） · Token 70"))).toBe(true);
    expect(remainingDetails.some((text) => text?.includes("其他模型（聚合） · Token 10"))).toBe(false);
    expect(remainingTooltips.some((text) => text?.includes("其他模型（聚合）（单一模型） · Token 70"))).toBe(true);
    expect(remainingTooltips.some((text) => text?.includes("其他模型（聚合） · Token 10"))).toBe(false);
  });

  it("renders explicit empty and error states", () => {
    const { rerender } = render(
      <ModelTokenTrendCard response={null} loading={false} error="请求失败" labelFor={(name) => name} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("模型趋势加载失败：请求失败");

    rerender(
      <ModelTokenTrendCard response={null} loading={false} error="/trend-by-model → 404" labelFor={(name) => name} />,
    );
    expect(screen.getByRole("alert").textContent).toBe("模型趋势数据源未启用");

    rerender(
      <ModelTokenTrendCard
        response={{
          fromDate: "2026-08-23",
          toDate: "2026-08-23",
          range: "custom",
          username: null,
          tenantId: null,
          family: null,
          points: [],
        }}
        loading={false}
        error={null}
        labelFor={(name) => name}
      />,
    );
    expect(screen.getByText("所选区间内暂无模型 Token 用量")).toBeTruthy();
  });
});
