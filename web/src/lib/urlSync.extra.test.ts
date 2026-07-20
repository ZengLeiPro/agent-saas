import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// maybeNavigateWithUpdate 默认返回 false（不劫持导航），与 urlSync.test.ts 保持一致
vi.mock("@/lib/swUpdate", () => ({
  maybeNavigateWithUpdate: () => false,
}));

import {
  buildAdminSettingsUrl,
  buildPlatformAdminUrl,
  buildSettingsUrl,
  buildUrl,
  isSettingsPath,
  normalizeAdminSettingsSection,
  normalizePlatformAdminSection,
  normalizeSettingsSection,
  parseUrl,
  pushSettingsUrl,
  pushUrl,
  replaceSettingsUrl,
  replaceUrl,
} from "@/lib/urlSync";

describe("normalizeSettingsSection", () => {
  it("合法 section 原样返回", () => {
    expect(normalizeSettingsSection("memory")).toBe("memory");
    expect(normalizeSettingsSection("files")).toBe("files");
  });
  it("非法 / 空值回退 account", () => {
    expect(normalizeSettingsSection("cron")).toBe("account");
    expect(normalizeSettingsSection("nope")).toBe("account");
    expect(normalizeSettingsSection(null)).toBe("account");
    expect(normalizeSettingsSection(undefined)).toBe("account");
  });
});

describe("normalizeAdminSettingsSection", () => {
  it("tenant 合法/非法回退 users", () => {
    expect(normalizeAdminSettingsSection("tenant", "billing")).toBe("billing");
    expect(normalizeAdminSettingsSection("tenant", "bogus")).toBe("users");
    expect(normalizeAdminSettingsSection("tenant", null)).toBe("users");
  });
  it("platform 合法/非法回退 tenants", () => {
    expect(normalizeAdminSettingsSection("platform", "models")).toBe("models");
    expect(normalizeAdminSettingsSection("platform", "bogus")).toBe("tenants");
  });
});

describe("normalizePlatformAdminSection", () => {
  it("合法原样、非法回退 overview", () => {
    expect(normalizePlatformAdminSection("runs")).toBe("runs");
    expect(normalizePlatformAdminSection("zzz")).toBe("overview");
    expect(normalizePlatformAdminSection(null)).toBe("overview");
  });
});

describe("isSettingsPath", () => {
  it("/settings 及其子路径为真，其它为假", () => {
    expect(isSettingsPath("/settings")).toBe(true);
    expect(isSettingsPath("/settings/cron")).toBe(true);
    expect(isSettingsPath("/chat/1")).toBe(false);
  });
});

describe("buildSettingsUrl / buildAdminSettingsUrl", () => {
  it("settings section 编码", () => {
    expect(buildSettingsUrl("files")).toBe("/settings/files");
  });
  it("admin settings 前缀区分 tenant / platform", () => {
    expect(buildAdminSettingsUrl("tenant", "billing")).toBe("/tenant-admin/settings/billing");
    expect(buildAdminSettingsUrl("platform", "models")).toBe("/platform-admin/settings/models");
    // 非法回退默认 section
    expect(buildAdminSettingsUrl("tenant", "bogus")).toBe("/tenant-admin/settings/users");
  });
});

describe("buildPlatformAdminUrl.formatSearch 各分支", () => {
  it("字符串 search（带/不带 ?）", () => {
    expect(buildPlatformAdminUrl({ section: "runs", search: "?a=1" })).toBe("/platform-admin/runs?a=1");
    expect(buildPlatformAdminUrl({ section: "runs", search: "a=1" })).toBe("/platform-admin/runs?a=1");
  });
  it("URLSearchParams search", () => {
    const p = new URLSearchParams({ x: "1" });
    expect(buildPlatformAdminUrl({ section: "runs", search: p })).toBe("/platform-admin/runs?x=1");
  });
  it("对象 search 跳过 null/undefined/空串", () => {
    expect(
      buildPlatformAdminUrl({ section: "runs", search: { a: 1, b: null, c: undefined, d: "", e: true } }),
    ).toBe("/platform-admin/runs?a=1&e=true");
  });
  it("空对象 search 不产生 query", () => {
    expect(buildPlatformAdminUrl({ section: "runs", search: {} })).toBe("/platform-admin/runs");
  });
});

describe("buildUrl 覆盖各 tab 分支", () => {
  const cases: Array<[Parameters<typeof buildUrl>[0], string]> = [
    ["cron", "/cron"],
    ["tenants", "/tenants"],
    ["tenant-admin", "/tenant-admin"],
    ["platform-admin", "/platform-admin"],
    ["files", "/files"],
    ["profile", "/profile"],
    ["capabilities", "/capabilities"],
    ["scenarios", "/capabilities/templates"],
    ["skills", "/skills"],
    ["usage", "/usage"],
    ["mcp", "/mcp"],
    ["models", "/models"],
    ["settings", "/settings"],
    ["trash", "/trash"],
  ];
  it.each(cases)("tab=%s → %s", (tab, expected) => {
    expect(buildUrl(tab, null)).toBe(expected);
  });

  it("chat tab：有 sessionId 编码，无则根路径", () => {
    expect(buildUrl("chat", "s/1")).toBe("/chat/s%2F1");
    expect(buildUrl("chat", null)).toBe("/");
  });
});

describe("parseUrl 常规路径分支", () => {
  it("tenant-admin settings modal 路径", () => {
    expect(parseUrl("/tenant-admin/settings/billing")).toMatchObject({
      tab: "tenant-admin",
      adminSettings: { target: "tenant", section: "billing" },
    });
    // 无 section 段回退默认 users
    expect(parseUrl("/tenant-admin/settings")).toMatchObject({
      adminSettings: { target: "tenant", section: "users" },
    });
  });

  it("settings 根与子 section", () => {
    expect(parseUrl("/settings")).toMatchObject({ tab: "chat", settingsSection: "account" });
    expect(parseUrl("/settings/memory")).toMatchObject({ tab: "chat", settingsSection: "memory" });
    expect(parseUrl("/settings/cron")).toMatchObject({ tab: "cron", canonicalPath: "/cron" });
  });

  it("chat/:id 解码，空 id 归零", () => {
    expect(parseUrl("/chat/abc%20d")).toMatchObject({ tab: "chat", sessionId: "abc d" });
    expect(parseUrl("/chat/")).toMatchObject({ tab: "chat", sessionId: null });
  });

  it("cron 走一级页面，files 走 settings modal", () => {
    expect(parseUrl("/cron")).toMatchObject({ tab: "cron", settingsSection: null });
    expect(parseUrl("/files")).toMatchObject({ tab: "chat", settingsSection: "files" });
  });

  it("profile / trash / templates", () => {
    expect(parseUrl("/profile").tab).toBe("profile");
    expect(parseUrl("/trash").tab).toBe("trash");
    expect(parseUrl("/templates")).toMatchObject({ tab: "capabilities", canonicalPath: "/capabilities/templates" });
  });

  it("tenant-admin 旧入口收敛", () => {
    for (const p of ["/users", "/skills", "/usage", "/tenant-admin"]) {
      expect(parseUrl(p).tab).toBe("tenant-admin");
    }
  });

  it("/tenants /models 落到 platform-admin overview", () => {
    expect(parseUrl("/tenants")).toMatchObject({ tab: "platform-admin", adminSection: "overview" });
    expect(parseUrl("/models")).toMatchObject({ tab: "platform-admin", adminSection: "overview" });
  });

  it("未知路径兜底 chat", () => {
    expect(parseUrl("/totally-unknown")).toMatchObject({ tab: "chat", sessionId: null });
  });
});

describe("pushUrl / replaceUrl 写入 history（jsdom）", () => {
  const origin = "http://localhost";
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("pushUrl 目标不同则 pushState", () => {
    const spy = vi.spyOn(window.history, "pushState");
    pushUrl("cron", null);
    expect(spy).toHaveBeenCalledWith({}, "", "/cron");
    expect(window.location.pathname).toBe("/cron");
  });

  it("pushUrl 目标与当前相同则不写 history", () => {
    window.history.replaceState({}, "", "/cron");
    const spy = vi.spyOn(window.history, "pushState");
    pushUrl("cron", null);
    expect(spy).not.toHaveBeenCalled();
  });

  it("replaceUrl 用 replaceState", () => {
    const spy = vi.spyOn(window.history, "replaceState");
    replaceUrl("files", null);
    expect(spy).toHaveBeenCalledWith({}, "", "/files");
  });

  it("pushSettingsUrl / replaceSettingsUrl", () => {
    const push = vi.spyOn(window.history, "pushState");
    pushSettingsUrl("files");
    expect(push).toHaveBeenCalledWith({}, "", "/settings/files");

    const replace = vi.spyOn(window.history, "replaceState");
    replaceSettingsUrl("memory");
    expect(replace).toHaveBeenCalledWith({}, "", "/settings/memory");
  });

  // origin 变量仅用于文档说明测试运行在 localhost，无需断言
  void origin;
});
