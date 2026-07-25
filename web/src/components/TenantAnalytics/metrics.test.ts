import { describe, expect, it } from "vitest";

import type { ModelAggregate } from "@/components/UsageDashboard/types";
import { buildModelSlices, countActiveEnabledUsers, rangeToStatsWindow, windowCaption } from "./metrics";

function model(model: string, totalTokens: number): ModelAggregate {
  return {
    model,
    totalTokens,
    totalCostUsd: 0,
    totalTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

describe("tenant analytics metrics", () => {
  it("按真实模型 ID 展示，不把 GLM、Ark 或 Codex 硬归为其它家族", () => {
    const slices = buildModelSlices([
      model("ark-agents/glm-5.2", 500),
      model("codex/gpt-5.5", 400),
      model("claude-opus-4-7", 300),
      model("kimi-k2.7-code", 200),
      model("minimax-m3", 100),
    ]);

    expect(slices.map(slice => slice.label)).toEqual([
      "ark-agents/glm-5.2",
      "codex/gpt-5.5",
      "claude-opus-4-7",
      "kimi-k2.7-code",
      "其余 1 个模型",
    ]);
    expect(slices.at(-1)?.value).toBe(100);
  });

  it("使用覆盖率只统计当前启用成员", () => {
    expect(countActiveEnabledUsers(["zenglei", "huangyiping"], ["zenglei", "disabled-user"])).toBe(1);
  });

  it("客户视角：getValue 换成轮次口径并按值降序", () => {
    const a = { ...model("ark-agents/glm-5.2", 100), totalTurns: 3 };
    const b = { ...model("claude-opus-4-7", 900), totalTurns: 10 };
    const zero = { ...model("codex/gpt-5.5", 50), totalTurns: 0 };
    const slices = buildModelSlices([a, b, zero], { getValue: m => m.totalTurns });

    // 轮次为 0 的模型不出现；按轮次降序
    expect(slices.map(slice => slice.label)).toEqual(["claude-opus-4-7", "ark-agents/glm-5.2"]);
    expect(slices[0].value).toBe(10);
  });

  it("客户视角：getLabel 映射为租户显示名，映射不到回退原 ID", () => {
    const names = new Map([["ark-agents/glm-5.2", "智谱 GLM"]]);
    const slices = buildModelSlices(
      [model("ark-agents/glm-5.2", 500), model("legacy-model", 100)],
      { getLabel: m => names.get(m.model) ?? m.model },
    );
    expect(slices.map(slice => slice.label)).toEqual(["智谱 GLM", "legacy-model"]);
  });
});

describe("统计窗口口径", () => {
  const TODAY = "2026-07-25";

  it("选“全部”时，任何有限 cap 都必须标记为截断", () => {
    // 这是原 bug 的核心：顶部显示“全部”，health 实际只有 30 天、credits 只有 90 天，
    // 且界面不作任何提示，客户会把 30 天的数字当成全部历史对外汇报。
    const health = rangeToStatsWindow("all", null, 30, TODAY);
    const credits = rangeToStatsWindow("all", null, 90, TODAY);

    expect(health).toEqual({ days: 30, capped: true });
    expect(credits).toEqual({ days: 90, capped: true });
    expect(windowCaption(health)).toBe("近 30 天（本区块数据上限）");
    expect(windowCaption(credits)).toBe("近 90 天（本区块数据上限）");
  });

  it("同一选择在不同 cap 下窗口不同，必须各自如实标注", () => {
    expect(rangeToStatsWindow("30d", null, 30, TODAY)).toEqual({ days: 30, capped: false });
    // 30 天请求落在 90 天 cap 内，不算截断
    expect(rangeToStatsWindow("30d", null, 90, TODAY)).toEqual({ days: 30, capped: false });
  });

  it("未触达上限时不加多余提示", () => {
    const window = rangeToStatsWindow("7d", null, 30, TODAY);
    expect(window).toEqual({ days: 7, capped: false });
    expect(windowCaption(window)).toBe("近 7 天");
  });

  it("本月至今按当天日期换算，超过 cap 时标记截断", () => {
    expect(rangeToStatsWindow("mtd", null, 90, TODAY)).toEqual({ days: 25, capped: false });
    // cap 小于当月已过天数 → 截断
    expect(rangeToStatsWindow("mtd", null, 10, TODAY)).toEqual({ days: 10, capped: true });
  });

  it("自定义区间超出 cap 时标记截断，非法区间回退 7 天", () => {
    expect(rangeToStatsWindow("custom", { from: "2026-01-01", to: "2026-07-25" }, 30, TODAY))
      .toEqual({ days: 30, capped: true });
    expect(rangeToStatsWindow("custom", { from: "2026-07-18", to: "2026-07-25" }, 30, TODAY))
      .toEqual({ days: 7, capped: false });
    // to <= from / 非法日期 → 回退 7 天且不谎报截断
    expect(rangeToStatsWindow("custom", { from: "2026-07-25", to: "2026-07-18" }, 30, TODAY))
      .toEqual({ days: 7, capped: false });
    expect(rangeToStatsWindow("custom", null, 30, TODAY)).toEqual({ days: 7, capped: false });
  });

  it("窗口天数下限为 1，不会出现 0 天或负数", () => {
    expect(rangeToStatsWindow("today", null, 30, TODAY).days).toBe(1);
    expect(rangeToStatsWindow("mtd", null, 30, "2026-07-01").days).toBe(1);
  });
});
