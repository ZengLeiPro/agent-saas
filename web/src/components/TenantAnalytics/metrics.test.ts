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
});
