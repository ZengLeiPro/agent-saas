import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/layouts/MobileLayout.tsx", "utf8");

describe("MobileLayout 管理模块接线", () => {
  it("每个组织管理壳实例都接入组织智能体模块", () => {
    const shellCount = source.match(/<TenantAdminShell\b/g)?.length ?? 0;
    const orgAgentRendererCount = source.match(/renderOrgAgents=/g)?.length ?? 0;

    expect(shellCount).toBeGreaterThan(0);
    expect(orgAgentRendererCount).toBe(shellCount);
  });
});
