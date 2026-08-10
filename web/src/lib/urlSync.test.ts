import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/swUpdate", () => ({
  maybeNavigateWithUpdate: () => false,
}));

import { buildAdminSettingsUrl, buildPlatformAdminUrl, buildUrl, parseUrl } from "@/lib/urlSync";

describe("platform admin url sync", () => {
  it("parses platform admin deep links without falling back to chat", () => {
    expect(parseUrl("/platform-admin")).toMatchObject({
      tab: "platform-admin",
      adminSection: "overview",
      adminEntityId: null,
      canonicalPath: "/platform-console/overview/overview",
    });

    expect(parseUrl("/platform-admin/runs/run_123", "?status=failed")).toMatchObject({
      tab: "platform-admin",
      adminSection: "runs",
      adminEntityId: "run_123",
      canonicalPath: "/platform-console/runtime/runs/run_123?status=failed",
    });

    expect(parseUrl("/platform-admin/infra")).toMatchObject({
      tab: "platform-admin",
      adminSection: "infra",
      adminEntityId: null,
      canonicalPath: "/platform-console/runtime/infra",
    });
  });

  it("canonicalizes legacy platform settings routes into V2 console leaves", () => {
    expect(parseUrl("/platform-admin/settings/signup")).toMatchObject({
      tab: "platform-admin",
      adminSection: "overview",
      adminSettings: null,
      canonicalPath: "/platform-console/org-business/signup",
    });

    expect(parseUrl("/platform-admin/settings/memory-polling")).toMatchObject({
      tab: "platform-admin",
      adminSection: "overview",
      adminSettings: null,
      canonicalPath: "/platform-console/governance/memory-policy",
    });
    expect(buildAdminSettingsUrl("platform", "memory-polling"))
      .toBe("/platform-admin/settings/memory-polling");
    expect(parseUrl("/platform-admin/settings/system-prompts")).toMatchObject({
      tab: "platform-admin",
      adminSection: "overview",
      adminSettings: null,
      canonicalPath: "/platform-console/governance/system-prompts",
    });
    expect(parseUrl("/platform-admin/settings/agent-profiles")).toMatchObject({
      tab: "platform-admin",
      adminSection: "overview",
      adminSettings: null,
      canonicalPath: "/platform-console/governance/system-settings",
    });
  });

  it("canonicalizes legacy runtime settings sections into entity sections", () => {
    expect(parseUrl("/platform-admin/settings/run-trace", "?q=abc")).toMatchObject({
      tab: "platform-admin",
      adminSection: "runs",
      adminSettings: null,
      canonicalPath: "/platform-console/runtime/runs?q=abc",
    });

    expect(parseUrl("/platform-admin/settings/runtime")).toMatchObject({
      tab: "platform-admin",
      adminSection: "sandboxes",
      adminSettings: null,
      canonicalPath: "/platform-console/runtime/environments",
    });
  });

  it("canonicalizes unknown platform admin sections to overview", () => {
    expect(parseUrl("/platform-admin/not-a-section", "?tenantId=kaiyan")).toMatchObject({
      tab: "platform-admin",
      adminSection: "overview",
      adminEntityId: null,
      canonicalPath: "/platform-admin/overview?tenantId=kaiyan",
    });
  });

  it("builds platform admin urls with optional entity and query", () => {
    expect(buildPlatformAdminUrl({ section: "sessions", entityId: "sub-123", search: { includeDeleted: true } }))
      .toBe("/platform-admin/sessions/sub-123?includeDeleted=true");
    expect(buildPlatformAdminUrl({ section: "infra" })).toBe("/platform-admin/infra");
  });
});

describe("能力中心 URL", () => {
  it("能力中心使用独立一级路径", () => {
    expect(parseUrl("/capabilities").tab).toBe("capabilities");
    expect(parseUrl("/capabilities/templates").tab).toBe("capabilities");
    expect(parseUrl("/capabilities/experts").tab).toBe("capabilities");
    expect(parseUrl("/capabilities/skills").tab).toBe("capabilities");
    expect(parseUrl("/capabilities/connectors").tab).toBe("capabilities");
    expect(buildUrl("capabilities", null)).toBe("/capabilities");
  });

  it("个人设置旧路径进入 V2 独立页面，产品级旧入口仍收敛到能力中心", () => {
    expect(parseUrl("/settings/skills")).toMatchObject({ tab: "chat", canonicalPath: "/settings/my-permissions" });
    expect(parseUrl("/settings/mcp")).toMatchObject({ tab: "chat", canonicalPath: "/settings/connections" });
    expect(parseUrl("/settings/all-agents")).toMatchObject({ tab: "chat", canonicalPath: "/settings/my-agent" });
    expect(parseUrl("/mcp")).toMatchObject({ tab: "capabilities", canonicalPath: "/capabilities/connectors" });
    for (const path of ["/agents", "/all-agents"]) {
      expect(parseUrl(path)).toMatchObject({ tab: "capabilities", canonicalPath: "/capabilities/experts" });
    }
  });

  it("旧任务模板入口收敛到能力中心首标签", () => {
    expect(parseUrl("/scenarios")).toMatchObject({ tab: "capabilities", canonicalPath: "/capabilities/templates" });
    expect(parseUrl("/templates")).toMatchObject({ tab: "capabilities", canonicalPath: "/capabilities/templates" });
    expect(buildUrl("scenarios", null)).toBe("/capabilities/templates");
  });
});
