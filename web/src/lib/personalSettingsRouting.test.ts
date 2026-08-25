import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/swUpdate", () => ({ maybeNavigateWithUpdate: () => false }));

import {
  buildSettingsUrl,
  closePersonalSettingsHistory,
  navigateSettingsRoute,
  parseUrl,
  pushAdminSettingsUrl,
  pushSettingsUrl,
  readPersonalSettingsHistoryState,
} from "./urlSync";
import { governanceRoute } from "./governanceNavigation";
import { usePersonalSettingsNavigation } from "@/hooks/usePersonalSettingsNavigation";

beforeEach(() => {
  window.history.replaceState({}, "", "/chat/source");
  vi.restoreAllMocks();
});

describe("V2 个人设置路由与来源返回", () => {
  it.each([
    ["account-security", "/settings/account-security"],
    ["my-agent", "/settings/my-agent"],
    ["chat-model", "/settings/chat-model"],
    ["appearance-layout", "/settings/appearance-layout"],
    ["my-permissions", "/settings/my-permissions"],
    ["connections", "/settings/connections"],
    ["files-storage", "/settings/files-storage"],
    ["trash", "/settings/trash"],
  ] as const)("%s 使用 canonical URL", (section, expected) => {
    expect(buildSettingsUrl(section)).toBe(expected);
    expect(parseUrl(expected)).toMatchObject({ settingsSection: section, canonicalPath: null });
  });

  it("旧 URL canonical 到 V2 页面并保留我的 Agent Memory 深链", () => {
    expect(parseUrl("/settings/account")).toMatchObject({ settingsSection: "account-security", canonicalPath: "/settings/account-security" });
    expect(parseUrl("/settings/memory")).toMatchObject({
      settingsSection: "my-agent",
      governanceRoute: { tab: "memory" },
      canonicalPath: "/settings/my-agent?tab=memory",
    });
  });

  it("页内深链累计来源深度，关闭一次退回来源；直达刷新用 replace", () => {
    pushSettingsUrl("account-security", { source: "/chat/source", depth: 1 });
    navigateSettingsRoute(governanceRoute("settings.personal.my-agent", { tab: "persona" }));
    expect(readPersonalSettingsHistoryState()).toEqual({ source: "/chat/source", depth: 2 });
    expect(window.location.href).toContain("/settings/my-agent?tab=persona");

    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    expect(closePersonalSettingsHistory("/fallback")).toBe("back");
    expect(go).toHaveBeenCalledWith(-2);

    window.history.replaceState({}, "", "/settings/connections");
    const replace = vi.spyOn(window.history, "replaceState");
    expect(closePersonalSettingsHistory("/chat/source")).toBe("replace");
    expect(replace).toHaveBeenLastCalledWith({}, "", "/chat/source");
  });

  it("直达设置深链后首次切页会先把当前历史位替换为产品来源", () => {
    window.history.replaceState({}, "", "/settings/connections");
    const replace = vi.spyOn(window.history, "replaceState");
    const { result } = renderHook(() => usePersonalSettingsNavigation({
      getActiveTab: () => "chat",
      getPlatformRoute: () => ({}),
      getTenantSection: () => "overview",
      getSessionId: () => "source",
      openState: vi.fn(),
      closeState: vi.fn(),
    }));

    act(() => result.current.setSettingsSection("files-storage"));

    expect(replace).toHaveBeenCalledWith({}, "", "/chat/source");
    expect(window.location.pathname).toBe("/settings/files-storage");
    expect(readPersonalSettingsHistoryState()).toEqual({ source: "/chat/source", depth: 1 });
  });

  it("组织和平台设置沿用同一来源与深度，统一返回不会落回另一套设置", () => {
    pushSettingsUrl("account-security", { source: "/chat/source", depth: 1 });
    pushAdminSettingsUrl("tenant", "users", { source: "/chat/source", depth: 2 });
    expect(readPersonalSettingsHistoryState()).toEqual({ source: "/chat/source", depth: 2 });

    pushAdminSettingsUrl("platform", "models", { source: "/chat/source", depth: 3 });
    expect(window.location.pathname).toBe("/platform-admin/settings/models");
    expect(readPersonalSettingsHistoryState()).toEqual({ source: "/chat/source", depth: 3 });

    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    expect(closePersonalSettingsHistory("/fallback")).toBe("back");
    expect(go).toHaveBeenCalledWith(-3);
  });
});
