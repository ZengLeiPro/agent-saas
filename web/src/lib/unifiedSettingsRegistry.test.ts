import { describe, expect, it } from "vitest";

import {
  SETTINGS_REGISTRY,
  getSettingsSection,
  groupPersonalSettingsSections,
  isSettingsSectionId,
  settingsFallbackSection,
  settingsSectionsForScope,
  type SettingsScope,
} from "@/lib/unifiedSettingsRegistry";
import {
  buildAdminSettingsUrl,
  governanceSettingsRoute,
  normalizeAdminSettingsSection,
  normalizeSettingsSection,
} from "@/lib/urlSync";

const EXPECTED_KEYS = [
  "personal:account-security",
  "personal:my-agent",
  "personal:chat-model",
  "personal:appearance-layout",
  "personal:my-permissions",
  "personal:connections",
  "personal:files-storage",
  "personal:trash",
  "tenant:users",
  "tenant:skills",
  "tenant:org-agents",
  "tenant:mcp",
  "tenant:connector-dictionary",
  "tenant:billing",
  "tenant:files",
  "tenant:company",
  "tenant:instructions",
  "tenant:settings",
  "platform:tenants",
  "platform:signup",
  "platform:models",
  "platform:billing",
  "platform:remote-hands",
  "platform:tool-controls",
  "platform:connector-dictionary",
  "platform:agent-profiles",
  "platform:system-prompts",
  "platform:memory-polling",
  "platform:global-mcp",
  "platform:skill-pool",
  "platform:egress",
  "platform:system",
] as const;

const EXPECTED_ACCESS_ACTION: Record<SettingsScope, string> = {
  personal: "settings.personal.view",
  tenant: "settings.tenant.view",
  platform: "settings.platform.view",
};

function expectUnique(values: readonly string[]) {
  expect(new Set(values).size).toBe(values.length);
}

describe("unified settings registry", () => {
  it("穷举唯一的 32 个叶子，scope 数量固定为 8/10/14", () => {
    expect(SETTINGS_REGISTRY.map((entry) => entry.key)).toEqual(EXPECTED_KEYS);
    expectUnique(SETTINGS_REGISTRY.map((entry) => entry.key));
    expect(settingsSectionsForScope("personal")).toHaveLength(8);
    expect(settingsSectionsForScope("tenant")).toHaveLength(10);
    expect(settingsSectionsForScope("platform")).toHaveLength(14);
  });

  it("保持 path、route 表示与 scope 内 id 唯一", () => {
    expectUnique(SETTINGS_REGISTRY.map((entry) => entry.path));
    expectUnique(SETTINGS_REGISTRY.map((entry) => "routeId" in entry ? entry.routeId : entry.path));
    for (const scope of ["personal", "tenant", "platform"] as const) {
      const entries = settingsSectionsForScope(scope);
      expectUnique(entries.map((entry) => entry.id));
      for (const entry of entries) {
        expect(entry.path).toBe(`/${scope === "personal" ? "settings" : `${scope}-admin/settings`}/${entry.id}`);
        expect(isSettingsSectionId(scope, entry.id)).toBe(true);
      }
      expect(isSettingsSectionId(scope, "not-a-section")).toBe(false);
    }
  });

  it("为每个 scope 赋予正确 accessAction，并从首项派生 fallback", () => {
    for (const entry of SETTINGS_REGISTRY) {
      expect(entry.accessAction).toBe(EXPECTED_ACCESS_ACTION[entry.scope]);
    }
    expect(settingsFallbackSection("personal")).toBe("account-security");
    expect(settingsFallbackSection("tenant")).toBe("users");
    expect(settingsFallbackSection("platform")).toBe("tenants");
  });

  it("按 const group 顺序分组个人设置", () => {
    const groups = groupPersonalSettingsSections(settingsSectionsForScope("personal"));
    expect(groups.map((group) => [group.group, group.items.length])).toEqual([
      ["personal", 2],
      ["preferences", 2],
      ["access", 2],
      ["data", 2],
    ]);
  });

  it("个人 routeId 与原有 canonical route 保持一一对应", () => {
    for (const entry of settingsSectionsForScope("personal")) {
      expect(governanceSettingsRoute(entry.id).routeId).toBe(entry.routeId);
      expect(entry.routeId).toBe(`settings.${entry.group}.${entry.id}`);
      expect(getSettingsSection("personal", entry.id)).toBe(entry);
    }
  });

  it.each([
    ["account", "account-security"],
    ["general", "chat-model"],
    ["personalization", "appearance-layout"],
    ["all-agents", "my-agent"],
    ["memory", "my-agent"],
    ["skills", "my-permissions"],
    ["mcp", "connections"],
    ["files", "files-storage"],
    ["storage", "files-storage"],
    ["data", "trash"],
  ] as const)("legacy personal section %s 仍 normalize 为 %s", (legacy, canonical) => {
    expect(normalizeSettingsSection(legacy)).toBe(canonical);
  });

  it("admin 合法性、fallback 与既有 URL 不回归", () => {
    expect(normalizeAdminSettingsSection("tenant", "billing")).toBe("billing");
    expect(normalizeAdminSettingsSection("tenant", "unknown")).toBe("users");
    expect(normalizeAdminSettingsSection("platform", "memory-polling")).toBe("memory-polling");
    expect(normalizeAdminSettingsSection("platform", "unknown")).toBe("tenants");
    expect(buildAdminSettingsUrl("tenant", "billing")).toBe("/tenant-admin/settings/billing");
    expect(buildAdminSettingsUrl("platform", "memory-polling")).toBe("/platform-admin/settings/memory-polling");
  });
});
