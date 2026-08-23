import { fireEvent, render, screen } from "@testing-library/react";
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
  it("keeps the interval Top 6 and conserves every day's tokens in 其他", () => {
    const result = prepareModelTrend(POINTS);

    expect(result.series.map((series) => series.label)).toEqual([
      "model-a",
      "model-b",
      "model-c",
      "model-d",
      "model-e",
      "model-f",
      "其他",
    ]);
    expect(result.points.map((point) => point.totalTokens)).toEqual([220, 24]);
    expect(result.points[0].segments.find((segment) => segment.key === "__other_models__")?.tokens).toBe(10);
    expect(result.points[1].segments.find((segment) => segment.key === "__other_models__")?.tokens).toBe(3);
    expect(result.points.every((point) => (
      point.segments.reduce((sum, segment) => sum + segment.tokens, 0) === point.totalTokens
    ))).toBe(true);
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

    expect(screen.getByRole("img", { name: /2026-08-23 · Alpha · Token 75 · 占比 75.0% · 输入 75 · 输出 0 · 缓存读 0 · 缓存写 0 · 轮次 1 · 成本 \$0.1000/ })).toBeTruthy();
    const legend = screen.getByRole("button", { name: "隐藏 Alpha" });
    expect(legend.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(legend);

    expect(screen.getByRole("button", { name: "显示 Alpha" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("img", { name: /2026-08-23 · Alpha/ })).toBeNull();
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
