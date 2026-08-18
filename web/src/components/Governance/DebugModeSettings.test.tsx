import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TENANT_SETTINGS } from "@/components/TenantManager/types";
import { MemberDebugModeSetting, TenantDebugModeSetting } from "./DebugModeSettings";

const mocks = vi.hoisted(() => ({
  getTenantSettings: vi.fn(),
  updateTenantSettings: vi.fn(),
  authFetch: vi.fn(),
  authUser: { tenantId: "tenant-a" },
  updateTenantFeatures: vi.fn(),
}));

vi.mock("@agent/shared/lib/governanceApi", () => ({
  governanceAccessApi: {
    getTenantSettings: mocks.getTenantSettings,
    updateTenantSettings: mocks.updateTenantSettings,
  },
}));
vi.mock("@/lib/authFetch", () => ({ authFetch: mocks.authFetch }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: mocks.authUser, updateTenantFeatures: mocks.updateTenantFeatures }) }));

const response = (allowed: boolean, enabled: boolean) => ({
  tenantId: "tenant-a",
  settings: {
    ...structuredClone(DEFAULT_TENANT_SETTINGS),
    features: {
      ...structuredClone(DEFAULT_TENANT_SETTINGS.features),
      debugModeAllowed: allowed,
      debugModeEnabled: enabled,
    },
  },
  updatedAt: "2026-08-18T07:00:00.000Z",
});

describe("DebugModeSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("平台关闭授权时同时提交关闭组织开关", async () => {
    mocks.getTenantSettings.mockResolvedValue(response(true, true));
    mocks.updateTenantSettings.mockResolvedValue(response(false, false));
    render(<TenantDebugModeSetting tenantId="tenant-a" level="platform" />);

    fireEvent.click(await screen.findByRole("switch", { name: "调试模式授权" }));

    await waitFor(() => expect(mocks.updateTenantSettings).toHaveBeenCalledWith("tenant-a", expect.objectContaining({
      expectedUpdatedAt: "2026-08-18T07:00:00.000Z",
      settings: expect.objectContaining({
        features: expect.objectContaining({ debugModeAllowed: false, debugModeEnabled: false }),
      }),
    })));
    expect(await screen.findByText("策略已保存")).toBeTruthy();
    expect(mocks.updateTenantFeatures).toHaveBeenCalledWith(expect.objectContaining({ debugModeAllowed: false, debugModeEnabled: false }));
  });

  it("平台未授权时组织开关不可用", async () => {
    mocks.getTenantSettings.mockResolvedValue(response(false, false));
    render(<TenantDebugModeSetting tenantId="tenant-a" level="organization" />);

    const toggle = await screen.findByRole("switch", { name: "成员调试模式" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/平台尚未授予调试模式/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(mocks.updateTenantSettings).not.toHaveBeenCalled();
  });

  it("成员个人开关沿用兼容 PATCH 接口", async () => {
    mocks.authFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ debugMode: true }) });
    const onSaved = vi.fn();
    render(<MemberDebugModeSetting userId="member/1" enabled={false} available onSaved={onSaved} />);

    fireEvent.click(screen.getByRole("switch", { name: "成员个人调试模式" }));

    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledWith("/api/auth/users/member%2F1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ debugMode: true }),
    })));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("组织未开放时不渲染成员个人开关", () => {
    render(<MemberDebugModeSetting userId="member-1" enabled available={false} onSaved={vi.fn()} />);
    expect(screen.queryByRole("switch", { name: "成员个人调试模式" })).toBeNull();
  });
});
