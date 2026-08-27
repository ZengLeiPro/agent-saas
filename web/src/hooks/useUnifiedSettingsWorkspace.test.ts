import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useUnifiedSettingsWorkspace } from "./useUnifiedSettingsWorkspace";

const mocks = vi.hoisted(() => ({ navigateGovernance: vi.fn() }));

vi.mock("@/lib/urlSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/urlSync")>();
  return { ...actual, navigateGovernance: mocks.navigateGovernance };
});

describe("useUnifiedSettingsWorkspace", () => {
  it("组织治理入口复用设置页脏数据守卫后再导航", () => {
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
    }));

    act(() => result.current.onControllerChange({ dirty: true, requestNavigation: guarded }));
    act(() => result.current.openOrganizationGovernance());

    expect(guarded).toHaveBeenCalledTimes(1);
    expect(mocks.navigateGovernance).not.toHaveBeenCalled();
    act(() => guarded.mock.calls[0][0]());
    expect(mocks.navigateGovernance).toHaveBeenCalledWith(expect.objectContaining({ routeId: "organization.members.list" }));
  });
});
