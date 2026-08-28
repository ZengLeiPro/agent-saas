import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildGovernanceUrl } from "@/lib/governanceNavigation";
import { pushAdminSettingsUrl } from "@/lib/urlSync";
import { useUnifiedSettingsWorkspace } from "./useUnifiedSettingsWorkspace";

const mocks = vi.hoisted(() => ({ navigateGovernance: vi.fn() }));

vi.mock("@/lib/urlSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/urlSync")>();
  return { ...actual, navigateGovernance: mocks.navigateGovernance };
});

describe("useUnifiedSettingsWorkspace", () => {
  beforeEach(() => {
    mocks.navigateGovernance.mockReset();
    window.history.replaceState({}, "", "/tenant-admin/settings/users");
  });

  it("选择组织后切换设置叶子，dirty guard 仍捕获点击瞬间的目标组织", () => {
    const guarded = vi.fn();
    const { result } = renderHook(() => useUnifiedSettingsWorkspace({
      settingsOpen: false,
      settingsSection: "account-security",
      adminSettings: { target: "tenant", section: "users" },
      openSettings: vi.fn(),
      closeSettings: vi.fn(),
      setSettingsSection: vi.fn(),
      openAdminSettings: vi.fn(),
      closeAdminSettings: vi.fn(),
      setAdminSettingsSection: (section) => pushAdminSettingsUrl("tenant", section),
      isPlatformAdmin: true,
    }));

    window.history.replaceState({}, "", "/tenant-admin/settings/users?org=tenant-a");
    act(() => result.current.navigate("tenant", "skills"));
    expect(window.location.pathname).toBe("/tenant-admin/settings/skills");
    expect(window.location.search).toBe("?org=tenant-a");
    act(() => result.current.onControllerChange({ dirty: true, requestNavigation: guarded }));
    act(() => result.current.openOrganizationGovernance());

    expect(guarded).toHaveBeenCalledTimes(1);
    expect(mocks.navigateGovernance).not.toHaveBeenCalled();
    window.history.replaceState({}, "", "/tenant-admin/settings/users?org=tenant-b");
    act(() => guarded.mock.calls[0][0]());
    expect(mocks.navigateGovernance).toHaveBeenCalledWith(expect.objectContaining({
      routeId: "organization.members.list",
      orgId: "tenant-a",
    }));
    expect(buildGovernanceUrl(mocks.navigateGovernance.mock.calls[0][0])).toBe("/tenant-admin/members/list?org=tenant-a");
  });

  it("跨设置分组后使用持久 Tenant Shell 的实际组织，而非当前 URL", () => {
    const guarded = vi.fn();
    window.history.replaceState({}, "", "/tenant-admin/settings/users");
    const { result } = renderHook(() => useUnifiedSettingsWorkspace({
      settingsOpen: false,
      settingsSection: "account-security",
      adminSettings: { target: "tenant", section: "users" },
      openSettings: vi.fn(),
      closeSettings: vi.fn(),
      setSettingsSection: vi.fn(),
      openAdminSettings: vi.fn(),
      closeAdminSettings: vi.fn(),
      setAdminSettingsSection: vi.fn(),
      isPlatformAdmin: true,
      organizationSettingsTargetId: "tenant-a",
    }));

    act(() => result.current.onControllerChange({ dirty: true, requestNavigation: guarded }));
    act(() => result.current.openOrganizationGovernance());
    window.history.replaceState({}, "", "/tenant-admin/settings/users?org=tenant-b");
    act(() => guarded.mock.calls[0][0]());

    expect(mocks.navigateGovernance.mock.calls[0][0]).toMatchObject({
      routeId: "organization.members.list",
      orgId: "tenant-a",
    });
    expect(buildGovernanceUrl(mocks.navigateGovernance.mock.calls[0][0])).toBe("/tenant-admin/members/list?org=tenant-a");
  });

  it("Shell 明确未选择组织时不回退 stale URL", () => {
    window.history.replaceState({}, "", "/tenant-admin/settings/users?org=tenant-b");
    const { result } = renderHook(() => useUnifiedSettingsWorkspace({
      settingsOpen: false,
      settingsSection: "account-security",
      adminSettings: { target: "tenant", section: "users" },
      openSettings: vi.fn(),
      closeSettings: vi.fn(),
      setSettingsSection: vi.fn(),
      openAdminSettings: vi.fn(),
      closeAdminSettings: vi.fn(),
      setAdminSettingsSection: vi.fn(),
      isPlatformAdmin: true,
      organizationSettingsTargetId: null,
    }));

    act(() => result.current.openOrganizationGovernance());

    expect(mocks.navigateGovernance.mock.calls[0][0]).toMatchObject({ orgId: null });
  });

  it("未选择目标组织时不伪造平台默认组织", () => {
    const { result } = renderHook(() => useUnifiedSettingsWorkspace({
      settingsOpen: false,
      settingsSection: "account-security",
      adminSettings: { target: "tenant", section: "users" },
      openSettings: vi.fn(),
      closeSettings: vi.fn(),
      setSettingsSection: vi.fn(),
      openAdminSettings: vi.fn(),
      closeAdminSettings: vi.fn(),
      setAdminSettingsSection: vi.fn(),
      isPlatformAdmin: true,
    }));

    act(() => result.current.openOrganizationGovernance());

    expect(mocks.navigateGovernance).toHaveBeenCalledWith(expect.objectContaining({
      routeId: "organization.members.list",
    }));
    expect(mocks.navigateGovernance.mock.calls[0][0]).toMatchObject({ orgId: null });
  });

  it("普通组织管理员忽略 URL 中的其他组织并继续使用本人作用域", () => {
    window.history.replaceState({}, "", "/tenant-admin/settings/users?org=tenant-b");
    const { result } = renderHook(() => useUnifiedSettingsWorkspace({
      settingsOpen: false,
      settingsSection: "account-security",
      adminSettings: { target: "tenant", section: "users" },
      openSettings: vi.fn(),
      closeSettings: vi.fn(),
      setSettingsSection: vi.fn(),
      openAdminSettings: vi.fn(),
      closeAdminSettings: vi.fn(),
      setAdminSettingsSection: vi.fn(),
      isPlatformAdmin: false,
    }));

    act(() => result.current.openOrganizationGovernance());

    expect(mocks.navigateGovernance.mock.calls[0][0]).toMatchObject({
      routeId: "organization.members.list",
      orgId: null,
    });
  });
});
