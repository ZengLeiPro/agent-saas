import { describe, expect, it } from "vitest";

import { filterModelsForViewer, isModelVisibleToTenantAdmin } from "./modelVisibility";

describe("组织管理员模型展示过滤", () => {
  it.each([
    "gpt-5.3-codex-spark",
    "openai-agents/gpt-5.3-codex-spark",
    "glm-5.2",
    "ark-agents/glm-5.2",
  ])("隐藏 %s", modelId => {
    expect(isModelVisibleToTenantAdmin(modelId)).toBe(false);
  });

  it("保留其他模型，并允许平台管理员查看全部模型", () => {
    const models = [
      { model: "claude-opus-4-7", totalTurns: 3 },
      { model: "gpt-5.3-codex-spark", totalTurns: 2 },
      { model: "ark-agents/glm-5.2", totalTurns: 1 },
    ];

    expect(filterModelsForViewer(models, false).map(item => item.model)).toEqual(["claude-opus-4-7"]);
    expect(filterModelsForViewer(models, true)).toBe(models);
  });
});
