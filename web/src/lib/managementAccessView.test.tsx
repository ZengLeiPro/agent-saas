import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ManagementSettingsAccessGate } from "@/components/ManagementSettingsAccessGate";
import type { ManagementSettingsAccess } from "@/hooks/useManagementSettingsAccess";
import { legacyRoleFallbackTab, managementAccessTarget } from "./managementAccessView";

const entryAccess = (allowed: boolean): ManagementSettingsAccess => ({
  status: "ready",
  personalAllowed: true,
  tenantEntryAllowed: allowed,
  platformEntryAllowed: allowed,
  retry: vi.fn(),
});

function renderEntry(
  target: "tenant" | "platform",
  allowed: boolean,
) {
  render(
    <ManagementSettingsAccessGate
      scope={target}
      target={target}
      access={entryAccess(allowed)}
      onRetry={vi.fn()}
      onReturnPersonal={vi.fn()}
    >
      <div data-testid="management-workspace" />
    </ManagementSettingsAccessGate>,
  );
}

describe("management workspace entry authority", () => {
  it.each([
    ["organization canonical", "tenant-admin", "organization", "tenant"],
    ["organization legacy", "tenant-admin", null, "tenant"],
    ["platform canonical", "platform-admin", "platform", "platform"],
    ["platform legacy", "platform-admin", null, "platform"],
  ] as const)("snapshot allow 时 legacy role=false 不改写 %s", (
    _case, activeTab, governanceArea, expectedTarget,
  ) => {
    expect(legacyRoleFallbackTab({
      activeTab,
      personalAgentEnabled: true,
      isAdmin: false,
      isPlatformAdmin: false,
    })).toBeNull();
    expect(managementAccessTarget({
      settingsOpen: false,
      adminSettingsTarget: null,
      activeTab,
      governanceArea,
    })).toBe(expectedTarget);

    renderEntry(expectedTarget, true);
    expect(screen.getByTestId("management-workspace")).toBeTruthy();
  });

  it.each(["tenant", "platform"] as const)(
    "合法 %s settings deep link 由 snapshot allow 放行，不读取 legacy role",
    (target) => {
      expect(legacyRoleFallbackTab({
        activeTab: "chat",
        personalAgentEnabled: true,
        isAdmin: false,
        isPlatformAdmin: false,
      })).toBeNull();
      expect(managementAccessTarget({
        settingsOpen: false,
        adminSettingsTarget: target,
        activeTab: "chat",
        governanceArea: null,
      })).toBe(target);

      renderEntry(target, true);
      expect(screen.getByTestId("management-workspace")).toBeTruthy();
    },
  );

  it.each(["tenant", "platform"] as const)(
    "%s snapshot deny 不 mount 管理工作区",
    (target) => {
      renderEntry(target, false);
      expect(screen.queryByTestId("management-workspace")).toBeNull();
    },
  );

  it.each([
    ["skills", false, false, "chat"],
    ["usage", false, false, "chat"],
    ["tenants", true, false, "chat"],
    ["models", true, false, "chat"],
    ["cron", true, true, null],
  ] as const)("非本轮 legacy tab %s 保留原角色逻辑", (
    activeTab, isAdmin, isPlatformAdmin, expected,
  ) => {
    expect(legacyRoleFallbackTab({ activeTab, personalAgentEnabled: true, isAdmin, isPlatformAdmin })).toBe(expected);
  });
});
