import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// maybeNavigateWithUpdate 默认返回 false（不劫持导航），与 urlSync.test.ts 保持一致
vi.mock("@/lib/swUpdate", () => ({
  maybeNavigateWithUpdate: () => false,
}));

import {
  CROSS_SECTION_SCOPE_KEYS,
  TENANT_ADMIN_SCOPE_KEYS,
  buildTenantAdminUrl,
  navigateAdminSettings,
  navigatePlatformAdmin,
  navigateTenantAdmin,
  navigateToHref,
  normalizeTenantAdminSection,
  parseTenantAdminPath,
  parseUrl,
  preserveScopeSearch,
  preserveSearchKeys,
  pushTenantAdminUrl,
  replaceTenantAdminUrl,
} from "@/lib/urlSync";

/**
 * S4 URL 契约测试。
 *
 * 这层是最容易静默回归的地方：改一个 key 名，分享出去的链接全部失效，而且不报错、不崩溃，
 * 只是「对方看到的是默认值」。所以每一个契约点都必须有断言。
 */

describe("normalizeTenantAdminSection", () => {
  it("四个合法页签原样返回", () => {
    expect(normalizeTenantAdminSection("overview")).toBe("overview");
    expect(normalizeTenantAdminSection("usage")).toBe("usage");
    expect(normalizeTenantAdminSection("qa")).toBe("qa");
    expect(normalizeTenantAdminSection("audit")).toBe("audit");
  });

  it("非法 / 空值回退 overview（不是崩溃、不是空白页）", () => {
    expect(normalizeTenantAdminSection("bogus")).toBe("overview");
    expect(normalizeTenantAdminSection("settings")).toBe("overview");
    expect(normalizeTenantAdminSection("")).toBe("overview");
    expect(normalizeTenantAdminSection(null)).toBe("overview");
    expect(normalizeTenantAdminSection(undefined)).toBe("overview");
  });
});

describe("buildTenantAdminUrl", () => {
  it("默认落 overview，页签进路径", () => {
    expect(buildTenantAdminUrl()).toBe("/tenant-admin/overview");
    expect(buildTenantAdminUrl({ section: "usage" })).toBe("/tenant-admin/usage");
    expect(buildTenantAdminUrl({ section: "qa" })).toBe("/tenant-admin/qa");
    expect(buildTenantAdminUrl({ section: "audit" })).toBe("/tenant-admin/audit");
  });

  it("search 支持 string / URLSearchParams / Record 三种入参", () => {
    expect(buildTenantAdminUrl({ section: "usage", search: "usageRange=90d" }))
      .toBe("/tenant-admin/usage?usageRange=90d");
    expect(buildTenantAdminUrl({ section: "usage", search: "?usageRange=90d" }))
      .toBe("/tenant-admin/usage?usageRange=90d");
    expect(buildTenantAdminUrl({ section: "usage", search: new URLSearchParams({ usageUser: "alice" }) }))
      .toBe("/tenant-admin/usage?usageUser=alice");
    expect(buildTenantAdminUrl({ section: "qa", search: { qaView: "board", qaBoardAgent: "" } }))
      .toBe("/tenant-admin/qa?qaView=board");
  });

  it("空 search 不留下裸问号", () => {
    expect(buildTenantAdminUrl({ section: "usage", search: "" })).toBe("/tenant-admin/usage");
    expect(buildTenantAdminUrl({ section: "usage", search: new URLSearchParams() })).toBe("/tenant-admin/usage");
  });
});

describe("parseTenantAdminPath", () => {
  it("解析四个页签", () => {
    expect(parseTenantAdminPath("/tenant-admin/usage")).toEqual({ section: "usage", canonicalPath: null });
    expect(parseTenantAdminPath("/tenant-admin/qa")).toEqual({ section: "qa", canonicalPath: null });
    expect(parseTenantAdminPath("/tenant-admin/audit")).toEqual({ section: "audit", canonicalPath: null });
    expect(parseTenantAdminPath("/tenant-admin/overview")).toEqual({ section: "overview", canonicalPath: null });
  });

  it("裸 /tenant-admin 落 overview 且不 canonical 改写（旧链接原样保留）", () => {
    expect(parseTenantAdminPath("/tenant-admin")).toEqual({ section: "overview", canonicalPath: null });
  });

  it("非法页签回落 overview 并给出 canonical 路径（带上原 search）", () => {
    expect(parseTenantAdminPath("/tenant-admin/nope", "?orgRange=30d")).toEqual({
      section: "overview",
      canonicalPath: "/tenant-admin/overview?orgRange=30d",
    });
  });

  it("组织管理弹窗路径让路（返回 null，交给 matchAdminSettingsPath）", () => {
    expect(parseTenantAdminPath("/tenant-admin/settings")).toBeNull();
    expect(parseTenantAdminPath("/tenant-admin/settings/billing")).toBeNull();
  });

  it("非 tenant-admin 路径返回 null", () => {
    expect(parseTenantAdminPath("/platform-admin/runs")).toBeNull();
    expect(parseTenantAdminPath("/chat/abc")).toBeNull();
    expect(parseTenantAdminPath("/tenant-administration")).toBeNull();
  });

  it("向后兼容：旧的 /usage 直达「用量与配额」页签", () => {
    expect(parseTenantAdminPath("/usage")).toEqual({
      section: "usage",
      canonicalPath: "/tenant-admin/usage",
    });
  });
});

describe("parseUrl 的 tenantAdminSection", () => {
  it("tenant-admin 深链带出页签", () => {
    expect(parseUrl("/tenant-admin/usage", "?usageRange=90d")).toMatchObject({
      tab: "tenant-admin",
      tenantAdminSection: "usage",
      adminSettings: null,
      canonicalPath: "/tenant-admin/governance/usage?usageRange=90d",
    });
  });

  it("裸 /tenant-admin 仍是 overview", () => {
    expect(parseUrl("/tenant-admin")).toMatchObject({
      tab: "tenant-admin",
      tenantAdminSection: "overview",
    });
  });

  it("组织管理弹窗路径不被当成分析页签", () => {
    expect(parseUrl("/tenant-admin/settings/billing")).toMatchObject({
      tab: "tenant-admin",
      tenantAdminSection: "usage",
      adminSettings: null,
      canonicalPath: "/tenant-admin/governance/usage",
    });
  });

  it("旧链接 /usage 落 usage 叶子并 canonical 到 V2", () => {
    expect(parseUrl("/usage")).toMatchObject({
      tab: "tenant-admin",
      tenantAdminSection: "usage",
      canonicalPath: "/tenant-admin/governance/usage",
    });
  });

  it("旧链接 /users、/skills 仍进 tenant-admin（无对应分析页签 → overview）", () => {
    expect(parseUrl("/users")).toMatchObject({ tab: "tenant-admin", tenantAdminSection: "overview" });
    expect(parseUrl("/skills")).toMatchObject({ tab: "tenant-admin", tenantAdminSection: "overview" });
  });

  it("platform-admin 路径的 tenantAdminSection 为 null（两套 URL 空间不串）", () => {
    expect(parseUrl("/platform-admin/runs")).toMatchObject({
      tab: "platform-admin",
      adminSection: "runs",
      tenantAdminSection: null,
    });
  });
});

describe("push/replaceTenantAdminUrl", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/tenant-admin/overview");
  });

  it("push 改变地址栏", () => {
    pushTenantAdminUrl({ section: "usage", search: { usageRange: "90d" } });
    expect(window.location.pathname).toBe("/tenant-admin/usage");
    expect(window.location.search).toBe("?usageRange=90d");
  });

  it("replace 不新建历史条目但改地址栏", () => {
    replaceTenantAdminUrl({ section: "audit" });
    expect(window.location.pathname).toBe("/tenant-admin/audit");
  });

  it("目标与当前一致时不写历史", () => {
    window.history.replaceState({}, "", "/tenant-admin/usage");
    pushTenantAdminUrl({ section: "usage" });
    expect(window.location.pathname).toBe("/tenant-admin/usage");
  });
});

describe("preserveSearchKeys / preserveScopeSearch", () => {
  it("只挑白名单键，其余（section 私有筛选）丢弃", () => {
    const kept = preserveSearchKeys(["tenantId", "userId"], "?tenantId=t1&userId=u1&kind=agent&cursor=abc");
    expect(kept.toString()).toBe("tenantId=t1&userId=u1");
  });

  it("空值不写入（避免 ?tenantId= 这种噪声）", () => {
    expect(preserveSearchKeys(["tenantId"], "?tenantId=").toString()).toBe("");
    expect(preserveSearchKeys(["tenantId"], "").toString()).toBe("");
  });

  it("跨 section 作用域键就是 tenantId / userId 两个", () => {
    expect([...CROSS_SECTION_SCOPE_KEYS]).toEqual(["tenantId", "userId"]);
  });

  it("tenant-admin 跨页签作用域键是 org（客户面参数名，不用内部 tenantId）", () => {
    expect([...TENANT_ADMIN_SCOPE_KEYS]).toEqual(["org"]);
    const kept = preserveSearchKeys(TENANT_ADMIN_SCOPE_KEYS, "?org=t2&orgRange=30d&usageUser=alice");
    expect(kept.toString()).toBe("org=t2");
  });

  it("omit 跳过目标实体自身代表的键", () => {
    const search = "?tenantId=t1&userId=u1&phase=Running";
    expect(preserveScopeSearch({ search, omit: ["tenantId"] }).toString()).toBe("userId=u1");
    expect(preserveScopeSearch({ search, omit: ["userId"] }).toString()).toBe("tenantId=t1");
    expect(preserveScopeSearch({ search }).toString()).toBe("tenantId=t1&userId=u1");
  });

  it("不传 search 时读 window.location.search", () => {
    window.history.replaceState({}, "", "/platform-admin/sessions?tenantId=t9&kind=agent");
    expect(preserveScopeSearch().toString()).toBe("tenantId=t9");
  });
});

describe("navigate* 是唯一的 popstate 派发点", () => {
  let seen = 0;
  const onPop = () => { seen += 1; };

  beforeEach(() => {
    seen = 0;
    window.addEventListener("popstate", onPop);
    window.history.replaceState({}, "", "/platform-admin/overview");
  });
  afterEach(() => {
    window.removeEventListener("popstate", onPop);
  });

  it("navigatePlatformAdmin 改 URL 并派发一次", () => {
    navigatePlatformAdmin({ section: "runs", entityId: "run_1", search: { tenantId: "t1" } });
    expect(window.location.pathname).toBe("/platform-admin/runs/run_1");
    expect(window.location.search).toBe("?tenantId=t1");
    expect(seen).toBe(1);
  });

  it("navigateTenantAdmin 改 URL 并派发一次", () => {
    navigateTenantAdmin({ section: "qa" });
    expect(window.location.pathname).toBe("/tenant-admin/qa");
    expect(seen).toBe(1);
  });

  it("navigateAdminSettings 打开管理弹窗路径并派发一次", () => {
    navigateAdminSettings("platform", "tenants");
    expect(window.location.pathname).toBe("/platform-admin/settings/tenants");
    expect(seen).toBe(1);
  });

  it("navigateToHref 直接跳任意应用内 href 并派发一次", () => {
    navigateToHref("/chat/sess_42");
    expect(window.location.pathname).toBe("/chat/sess_42");
    expect(seen).toBe(1);
  });

  it("目标与当前 URL 相同时仍派发（调用方语义是「让界面重新读 URL」）", () => {
    navigatePlatformAdmin({ section: "overview" });
    expect(seen).toBe(1);
  });
});
