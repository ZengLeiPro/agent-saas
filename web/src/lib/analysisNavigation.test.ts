import { describe, expect, it } from "vitest";

import { GOVERNANCE_ROUTES, governanceRoute } from "@/lib/governanceNavigation";
import { ANALYSIS_NAVIGATION, analysisNavigationRoute, getAnalysisNavigationItem } from "./analysisNavigation";

describe("分析导航注册表", () => {
  it("固定收纳 8 个平台分析页与 4 个组织分析页", () => {
    expect(ANALYSIS_NAVIGATION.map((group) => [group.scope, group.items.length])).toEqual([
      ["platform", 8],
      ["organization", 4],
    ]);
  });

  it("所有 routeId 唯一且存在于治理路由注册表", () => {
    const routeIds = ANALYSIS_NAVIGATION.flatMap((group) => group.items.map((item) => item.routeId));
    const governanceRouteIds = new Set(GOVERNANCE_ROUTES.map((route) => route.id));

    expect(new Set(routeIds).size).toBe(routeIds.length);
    expect(routeIds.filter((routeId) => !governanceRouteIds.has(routeId))).toEqual([]);
  });

  it("只把明确列入目录的治理路由识别为分析页", () => {
    expect(getAnalysisNavigationItem("platform.runtime.runs")?.scope).toBe("platform");
    expect(getAnalysisNavigationItem("organization.governance.usage")?.scope).toBe("organization");
    expect(getAnalysisNavigationItem("platform.resource-center.models")).toBeNull();
  });

  it("跨分析分组时保留最近一次显式组织作用域", () => {
    const organizationRoute = governanceRoute("organization.governance.usage", { orgId: "acme" });
    expect(analysisNavigationRoute("organization.governance.qa", organizationRoute)?.orgId).toBe("acme");
    expect(analysisNavigationRoute("organization.overview.overview", governanceRoute("platform.runtime.runs"), "beta")?.orgId).toBe("beta");
    expect(analysisNavigationRoute("platform.runtime.infra", organizationRoute)?.orgId).toBeNull();
    expect(analysisNavigationRoute("platform.resource-center.models", organizationRoute)).toBeNull();
  });

  it("跨平台分析项只透传 tenantId 与 userId 作用域", () => {
    const sessions = governanceRoute("platform.runtime.sessions", {
      search: "?tenantId=acme&userId=u1&status=failed&hours=168",
    });

    expect(analysisNavigationRoute("platform.runtime.runs", sessions)?.search)
      .toBe("?tenantId=acme&userId=u1");
  });
});
