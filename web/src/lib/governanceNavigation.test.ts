import { afterEach, describe, expect, it, vi } from "vitest";

const swUpdateMocks = vi.hoisted(() => ({ maybeNavigateWithUpdate: vi.fn(() => false) }));
vi.mock("@/lib/swUpdate", () => swUpdateMocks);

import {
  GOVERNANCE_NAVIGATION,
  GOVERNANCE_ROUTES,
  buildGovernanceUrl,
  buildOrganizationSwitchUrl,
  canonicalGovernanceUrl,
  filterCustomerOrganizations,
  governanceRoute,
  isCustomerOrganizationId,
  parseGovernanceUrl,
  safeGovernanceReturnTo,
} from "@/lib/governanceNavigation";
import { navigateGovernance, pushGovernanceUrl, replaceGovernanceUrl } from "@/lib/urlSync";

function expectRoute(input: string, routeId: string, canonicalPath: string | null = null) {
  const parsed = parseGovernanceUrl(input);
  expect(parsed).toMatchObject({ kind: "route", route: { routeId }, canonicalPath });
  return parsed.kind === "route" ? parsed.route : null;
}

describe("governance navigation registry", () => {
  it("只暴露平台/组织各五个工作区，并完整登记本地叶子与八个个人设置页", () => {
    expect(GOVERNANCE_NAVIGATION.platform.map((item) => item.id)).toEqual([
      "overview", "org-business", "resource-center", "runtime", "governance",
    ]);
    expect(GOVERNANCE_NAVIGATION.organization.map((item) => item.id)).toEqual([
      "overview", "members", "agents", "governance", "settings",
    ]);
    expect(GOVERNANCE_NAVIGATION.platform.flatMap((item) => item.routes)).toHaveLength(25);
    expect(GOVERNANCE_NAVIGATION.organization.flatMap((item) => item.routes).filter((item) => item.navigation !== "detail")).toHaveLength(27);
    expect(GOVERNANCE_NAVIGATION.settings[0].routes).toHaveLength(8);
  });

  it("平台与组织控制台菜单全部使用中文标签", () => {
    const labels = [
      ...GOVERNANCE_NAVIGATION.platform.map((workspace) => workspace.label),
      ...GOVERNANCE_NAVIGATION.organization.map((workspace) => workspace.label),
      ...GOVERNANCE_ROUTES.filter((route) => route.area !== "settings").map((route) => route.label),
    ];
    expect(labels.every((label) => /[\u3400-\u9fff]/.test(label))).toBe(true);
    expect(labels).not.toContain("Agent Template");
    expect(labels).not.toContain("Execution Provider");
    expect(labels).not.toContain("Session");
  });

  it("registry 中每条 route 均可 build/parse/canonical round-trip", () => {
    for (const definition of GOVERNANCE_ROUTES) {
      const entityId = definition.entity === "none" ? null : "entity 42";
      const tabs = definition.tabs ?? [undefined];
      for (const tab of tabs) {
        const state = governanceRoute(definition.id, {
          entityId,
          tab,
          orgId: definition.area === "organization" ? "org-kaiyan" : null,
          search: "?z=last&a=first",
        });
        const href = buildGovernanceUrl(state);
        const parsed = parseGovernanceUrl(href);
        expect(parsed, definition.id).toMatchObject({
          kind: "route",
          route: {
            routeId: definition.id,
            entityId,
            tab: tab ?? definition.defaultTab ?? null,
            orgId: definition.area === "organization" ? "org-kaiyan" : null,
            search: "?a=first&z=last",
          },
          canonicalPath: null,
          legacy: false,
        });
        expect(canonicalGovernanceUrl(href), definition.id).toBeNull();
      }
    }
  });

  it("实体详情和固定 tab 均进入稳定 URL", () => {
    expect(buildGovernanceUrl(governanceRoute("platform.org-business.tenants", {
      entityId: "tenant 1", tab: "resource-scope",
    }))).toBe("/platform-console/org-business/tenants/tenant%201/resource-scope");
    expect(buildGovernanceUrl(governanceRoute("platform.org-business.tenants", {
      entityId: "tenant 1", tab: "configuration",
    }))).toBe("/platform-console/org-business/tenants/tenant%201/configuration");
    expect(buildGovernanceUrl(governanceRoute("organization.members.member", {
      orgId: "org-1", entityId: "user-1", tab: "security-audit",
    }))).toBe("/tenant-admin/members/member/user-1/security-audit?org=org-1");
    expect(buildGovernanceUrl(governanceRoute("settings.personal.my-agent", { tab: "memory" })))
      .toBe("/settings/my-agent?tab=memory");
  });

  it("已弃用的 Persona 深链 canonical 到资料页", () => {
    expect(parseGovernanceUrl("/settings/my-agent?tab=persona")).toMatchObject({
      kind: "route",
      route: { routeId: "settings.personal.my-agent", tab: "agent-profile" },
      canonicalPath: "/settings/my-agent",
    });
    expect(canonicalGovernanceUrl("/settings/my-agent?tab=persona")).toBe("/settings/my-agent");
  });

  it("缺省详情 tab 会 canonical 到显式默认 tab", () => {
    expectRoute(
      "/platform-console/org-business/tenants/acme",
      "platform.org-business.tenants",
      "/platform-console/org-business/tenants/acme/overview",
    );
    expectRoute(
      "/tenant-admin/members/member/u1?org=acme",
      "organization.members.member",
      "/tenant-admin/members/member/u1/profile?org=acme",
    );
  });
});

describe("legacy URL canonical adapters", () => {
  it.each([
    ["/platform-admin", "platform.overview.overview", "/platform-console/overview/overview"],
    ["/platform-admin/overview", "platform.overview.overview", "/platform-console/overview/overview"],
    ["/platform-admin/tenants/acme?status=active", "platform.org-business.tenants", "/platform-console/org-business/tenants/acme/overview?status=active"],
    ["/platform-admin/users", "platform.org-business.users", "/platform-console/org-business/users"],
    ["/platform-admin/sessions/s1", "platform.runtime.sessions", "/platform-console/runtime/sessions/s1"],
    ["/platform-admin/runs/r1", "platform.runtime.runs", "/platform-console/runtime/runs/r1"],
    ["/platform-admin/sandboxes", "platform.runtime.environments", "/platform-console/runtime/environments"],
    ["/platform-admin/infra", "platform.runtime.infra", "/platform-console/runtime/infra"],
    ["/platform-admin/provider-quota", "platform.runtime.provider-quota", "/platform-console/runtime/provider-quota"],
    ["/platform-admin/audit", "platform.governance.audit", "/platform-console/governance/audit"],
    ["/platform-admin/efficiency", "platform.runtime.efficiency", "/platform-console/runtime/efficiency"],
    ["/platform-admin/settings/tenants", "platform.org-business.tenants", "/platform-console/org-business/tenants"],
    ["/platform-admin/settings/models", "platform.resource-center.models", "/platform-console/resource-center/models"],
    ["/platform-admin/settings/system-prompts", "platform.governance.system-prompts", "/platform-console/governance/system-prompts"],
    ["/platform-admin/settings/egress", "platform.governance.network-security", "/platform-console/governance/network-security"],
  ])("%s → %s", (legacy, routeId, canonical) => {
    expect(parseGovernanceUrl(legacy)).toMatchObject({
      kind: "route", legacy: true, route: { routeId }, canonicalPath: canonical,
    });
  });

  it.each([
    ["/tenant-admin", "organization.overview.overview", "/tenant-admin/overview"],
    ["/tenant-admin/usage?org=acme&usageRange=90d", "organization.governance.usage", "/tenant-admin/governance/usage?org=acme&usageRange=90d"],
    ["/tenant-admin/qa?org=acme", "organization.governance.qa", "/tenant-admin/governance/qa?org=acme"],
    ["/tenant-admin/audit?org=acme", "organization.governance.audit", "/tenant-admin/governance/audit?org=acme"],
    ["/tenant-admin/settings/users?org=acme", "organization.members.accounts", "/tenant-admin/members/accounts?org=acme"],
    ["/tenant-admin/settings/org-agents?org=acme", "organization.agents.org-agents", "/tenant-admin/agents/org-agents?org=acme"],
    ["/tenant-admin/settings/mcp?org=acme", "organization.agents.mcp-catalog", "/tenant-admin/agents/mcp-catalog?org=acme"],
    ["/tenant-admin/settings/connector-dictionary?org=acme", "organization.agents.connector-mappings", "/tenant-admin/agents/connector-mappings?org=acme"],
    ["/tenant-admin/settings/company?org=acme", "organization.settings.profile", "/tenant-admin/settings/profile?org=acme"],
    ["/tenant-admin/settings/settings?org=acme", "organization.settings.general", "/tenant-admin/settings/general?org=acme"],
    ["/users?org=acme", "organization.members.accounts", "/tenant-admin/members/accounts?org=acme"],
    ["/skills?org=acme", "organization.agents.skills", "/tenant-admin/agents/skills?org=acme"],
  ])("%s → %s且不丢 org", (legacy, routeId, canonical) => {
    expect(parseGovernanceUrl(legacy)).toMatchObject({
      kind: "route", legacy: true, route: { routeId, orgId: legacy.includes("org=acme") ? "acme" : null }, canonicalPath: canonical,
    });
  });

  it.each([
    ["/settings", "settings.personal.account-security", "/settings/account-security"],
    ["/settings/account", "settings.personal.account-security", "/settings/account-security"],
    ["/settings/general", "settings.preferences.chat-model", "/settings/chat-model"],
    ["/settings/personalization", "settings.preferences.appearance-layout", "/settings/appearance-layout"],
    ["/settings/all-agents", "settings.personal.my-agent", "/settings/my-agent"],
    ["/settings/memory", "settings.personal.my-agent", "/settings/my-agent?tab=memory"],
    ["/settings/skills", "settings.access.my-permissions", "/settings/my-permissions"],
    ["/settings/mcp", "settings.access.connections", "/settings/connections"],
    ["/settings/files", "settings.data.files-storage", "/settings/files-storage"],
    ["/settings/storage", "settings.data.files-storage", "/settings/files-storage"],
    ["/settings/data", "settings.data.trash", "/settings/trash"],
  ])("%s → %s", (legacy, routeId, canonical) => {
    expect(parseGovernanceUrl(legacy)).toMatchObject({
      kind: "route", legacy: true, route: { routeId }, canonicalPath: canonical,
    });
  });
});

describe("invalid route and scope safety", () => {
  it.each([
    ["/platform-console/runtime/not-real", "unknown-route"],
    ["/platform-console/runtime/runs/r1/extra", "unexpected-entity"],
    ["/platform-console/org-business/tenants/t1/not-a-tab", "invalid-tab"],
    ["/tenant-admin/members/member?org=acme", "missing-entity"],
    ["/tenant-admin/members/list/extra?org=acme", "unexpected-entity"],
    ["/settings/my-agent?tab=secret", "invalid-tab"],
    ["/platform-console/%E0%A4%A", "malformed"],
    ["/platform-console/runtime/%2e%2e/runs", "malformed"],
    ["https://evil.example/platform-console/overview/overview", "malformed"],
  ])("拒绝非法路径 %s", (href, reason) => {
    expect(parseGovernanceUrl(href)).toEqual({ kind: "invalid", reason });
  });

  it("pantheon 不能作为客户组织 scope 或进入客户组织列表", () => {
    expect(parseGovernanceUrl("/tenant-admin/overview?org=pantheon")).toEqual({ kind: "invalid", reason: "forbidden-org" });
    expect(parseGovernanceUrl("/platform-console/org-business/tenants/pantheon/overview")).toEqual({ kind: "invalid", reason: "forbidden-org" });
    expect(parseGovernanceUrl("/platform-admin/tenants/pantheon")).toEqual({ kind: "invalid", reason: "forbidden-org" });
    expect(() => buildGovernanceUrl(governanceRoute("organization.overview.overview", { orgId: "Pantheon" }))).toThrow();
    expect(() => buildGovernanceUrl(governanceRoute("platform.org-business.tenants", { entityId: "pantheon" }))).toThrow();
    expect(isCustomerOrganizationId("pantheon")).toBe(false);
    expect(filterCustomerOrganizations([{ id: "pantheon" }, { id: "acme" }])).toEqual([{ id: "acme" }]);
  });

  it("安全 returnTo 只接受站内绝对路径", () => {
    expect(safeGovernanceReturnTo("/chat/s1?focus=run#latest")).toBe("/chat/s1?focus=run#latest");
    expect(safeGovernanceReturnTo("/platform-console/runtime/runs/r1")).toBe("/platform-console/runtime/runs/r1");
    for (const unsafe of [
      "https://evil.example/x", "//evil.example/x", "/\\evil.example/x", "/%2e%2e/admin", "/safe/%2f%2fevil.example", "javascript:alert(1)",
    ]) {
      expect(safeGovernanceReturnTo(unsafe, "/fallback"), unsafe).toBe("/fallback");
    }
  });
});

describe("history compatibility adapters", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("push/replace 使用同一 build 合同，navigate 统一派发 popstate", () => {
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    let popstates = 0;
    const onPopstate = () => { popstates += 1; };
    window.addEventListener("popstate", onPopstate);

    const runs = governanceRoute("platform.runtime.runs", { entityId: "run-1" });
    pushGovernanceUrl(runs);
    expect(push).toHaveBeenCalledWith({ __appHistoryIndex: 1 }, "", "/platform-console/runtime/runs/run-1");

    const audit = governanceRoute("platform.governance.audit");
    replaceGovernanceUrl(audit);
    expect(replace).toHaveBeenCalledWith({ __appHistoryIndex: 1 }, "", "/platform-console/governance/audit");

    navigateGovernance(governanceRoute("organization.governance.qa", { orgId: "acme" }));
    expect(window.location.href).toContain("/tenant-admin/governance/qa?org=acme");
    expect(popstates).toBe(1);
    expect(swUpdateMocks.maybeNavigateWithUpdate).not.toHaveBeenCalled();
    window.removeEventListener("popstate", onPopstate);
  });
});

describe("organization switch cleanup", () => {
  it("切 org 保留工作区/叶子但清除实体、tab 与页内筛选", () => {
    const member = governanceRoute("organization.members.member", {
      orgId: "org-a",
      entityId: "user-a",
      tab: "assignments",
      search: "?q=alice&cursor=next&resourceId=r1",
    });
    expect(buildOrganizationSwitchUrl(member, "org-b")).toBe("/tenant-admin/members/list?org=org-b");

    const connector = governanceRoute("organization.agents.connectors", {
      orgId: "org-a",
      entityId: "credential-a",
      search: "?status=failed&member=u1",
    });
    expect(buildOrganizationSwitchUrl(connector, "org-b")).toBe("/tenant-admin/agents/connectors?org=org-b");
  });

  it("切 org 拒绝 pantheon，且不接受平台 route", () => {
    expect(() => buildOrganizationSwitchUrl(governanceRoute("organization.overview.overview", { orgId: "org-a" }), "pantheon")).toThrow();
    expect(() => buildOrganizationSwitchUrl(governanceRoute("platform.overview.overview"), "org-b")).toThrow();
  });
});
