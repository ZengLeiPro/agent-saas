import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildGovernanceUrl } from "@/lib/governanceNavigation";
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

  it("组织治理入口复用 dirty guard 并捕获点击瞬间的显式目标组织", () => {
    const guarded = vi.fn();
    const { result } = renderHook(() => useUnifiedSettingsWorkspace({
      settingsOpen: true,
      settingsSection: "account-security",
      adminSettings: null,
      openSettings: vi.fn(),
      closeSettings: vi.fn(),
      setSettingsSection: vi.fn(),
      openAdminSettings: vi.fn(),
      closeAdminSettings: vi.fn(),
      setAdminSettingsSection: vi.fn(),
      isPlatformAdmin: true,
    }));

    act(() => result.current.onControllerChange({ dirty: true, requestNavigation: guarded }));
    window.history.replaceState({}, "", "/tenant-admin/settings/users?org=tenant-a");
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
