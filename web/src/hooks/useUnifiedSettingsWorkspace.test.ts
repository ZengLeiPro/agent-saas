import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildGovernanceUrl, governanceRoute } from "@/lib/governanceNavigation";
import { useUnifiedSettingsWorkspace } from "./useUnifiedSettingsWorkspace";

const mocks = vi.hoisted(() => ({ navigateSettingsRoute: vi.fn() }));

vi.mock("@/lib/urlSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/urlSync")>();
  return { ...actual, navigateSettingsRoute: mocks.navigateSettingsRoute };
});

function baseProps() {
  return {
    settingsOpen: false,
    settingsSection: "account-security" as const,
    adminSettings: null,
    openSettings: vi.fn(),
    closeSettings: vi.fn(),
    setSettingsSection: vi.fn(),
    openAdminSettings: vi.fn(),
    closeAdminSettings: vi.fn(),
    setAdminSettingsSection: vi.fn(),
    isPlatformAdmin: false,
  };
}

describe("useUnifiedSettingsWorkspace", () => {
  beforeEach(() => {
    mocks.navigateSettingsRoute.mockReset();
  });

  it("organization 深链直接进入统一 tenant 设置模式并激活所属分类", () => {
    const route = governanceRoute("organization.members.member", {
      entityId: "u1",
      tab: "profile",
      orgId: "tenant-a",
    });
    const { result } = renderHook(() => useUnifiedSettingsWorkspace({
      ...baseProps(),
      governanceRoute: route,
    }));

    expect(result.current.mode).toBe(true);
    expect(result.current.target).toBe("tenant");
    expect(result.current.activeSection).toBe("org-members");
  });

  it("切换组织分类经过 dirty guard，并保留点击瞬间的 org", async () => {
    const guarded = vi.fn();
    const route = governanceRoute("organization.members.list", { orgId: "tenant-a" });
    const { result } = renderHook(() => useUnifiedSettingsWorkspace({
      ...baseProps(),
      governanceRoute: route,
    }));

    act(() => result.current.onControllerChange({ dirty: true, requestNavigation: guarded }));
    act(() => result.current.navigate("tenant", "agents"));

    expect(guarded).toHaveBeenCalledTimes(1);
    expect(mocks.navigateSettingsRoute).not.toHaveBeenCalled();
    await act(async () => guarded.mock.calls[0][0]());
    await vi.waitFor(() => expect(mocks.navigateSettingsRoute).toHaveBeenCalledTimes(1));
    const target = mocks.navigateSettingsRoute.mock.calls[0][0];
    expect(target).toMatchObject({ routeId: "organization.agents.org-agents", orgId: "tenant-a" });
    expect(buildGovernanceUrl(target)).toBe("/tenant-admin/agents/org-agents?org=tenant-a");
  });

  it("平台管理员从其他设置范围进入组织管理时只使用 Shell 显式目标", async () => {
    const { result } = renderHook(() => useUnifiedSettingsWorkspace({
      ...baseProps(),
      adminSettings: { target: "platform", section: "tenants" },
      isPlatformAdmin: true,
      organizationSettingsTargetId: "tenant-a",
    }));

    act(() => result.current.navigate("tenant", "overview"));
    await vi.waitFor(() => expect(mocks.navigateSettingsRoute).toHaveBeenCalledTimes(1));
    expect(mocks.navigateSettingsRoute.mock.calls[0][0]).toMatchObject({
      routeId: "organization.overview.overview",
      orgId: "tenant-a",
    });
  });

  it("平台管理员未明确选择组织时保持空 org 阻断态", async () => {
    const { result } = renderHook(() => useUnifiedSettingsWorkspace({
      ...baseProps(),
      adminSettings: { target: "platform", section: "tenants" },
      isPlatformAdmin: true,
      organizationSettingsTargetId: null,
    }));

    act(() => result.current.navigate("tenant", "settings"));
    await vi.waitFor(() => expect(mocks.navigateSettingsRoute).toHaveBeenCalledTimes(1));
    expect(mocks.navigateSettingsRoute.mock.calls[0][0]).toMatchObject({
      routeId: "organization.settings.profile",
      orgId: null,
    });
  });

  it("关闭 organization 设置也经过统一 dirty guard", () => {
    const guarded = vi.fn();
    const closeOrganizationSettings = vi.fn();
    const { result } = renderHook(() => useUnifiedSettingsWorkspace({
      ...baseProps(),
      governanceRoute: governanceRoute("organization.members.list"),
      closeOrganizationSettings,
    }));

    act(() => result.current.onControllerChange({ dirty: true, requestNavigation: guarded }));
    act(() => result.current.close());
    expect(guarded).toHaveBeenCalledTimes(1);
    expect(closeOrganizationSettings).not.toHaveBeenCalled();
    act(() => guarded.mock.calls[0][0]());
    expect(closeOrganizationSettings).toHaveBeenCalledTimes(1);
  });
});
