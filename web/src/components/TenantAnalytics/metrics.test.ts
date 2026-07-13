import { describe, expect, it } from "vitest";

import type { ModelAggregate } from "@/components/UsageDashboard/types";
import { buildModelSlices, countActiveEnabledUsers } from "./metrics";

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
