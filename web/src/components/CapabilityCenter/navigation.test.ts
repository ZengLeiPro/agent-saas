import { describe, expect, it } from "vitest";
import { capabilityTabFromPath } from "./navigation";

describe("能力中心标签路由", () => {
  it("默认与旧任务模板入口都落到第一个标签", () => {
    for (const path of ["/capabilities", "/capabilities/templates", "/templates", "/scenarios"]) {
      expect(capabilityTabFromPath(path)).toBe("templates");
    }
  });

  it("保留专家、技能和连接器的独立路径", () => {
    expect(capabilityTabFromPath("/capabilities/experts")).toBe("experts");
    expect(capabilityTabFromPath("/capabilities/skills")).toBe("skills");
    expect(capabilityTabFromPath("/capabilities/connectors")).toBe("connectors");
  });

  it("未开放个人通用 Agent 时隐藏任务模板并默认进入专家", () => {
    expect(capabilityTabFromPath("/capabilities", false)).toBe("experts");
    expect(capabilityTabFromPath("/capabilities/templates", false)).toBe("experts");
  });
});
