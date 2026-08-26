import {
  Gauge,
  HardDrive,
  ListTree,
  MessageSquareText,
  ServerCog,
  Users,
  type LucideIcon,
} from "lucide-react";

import { EntityIcons } from "@/lib/icons";
import { governanceRoute, type GovernanceRouteState } from "@/lib/governanceNavigation";

export type AnalysisScope = "platform" | "organization";

export interface AnalysisNavigationItem {
  routeId: string;
  label: string;
  icon: LucideIcon;
}

export interface AnalysisNavigationGroup {
  scope: AnalysisScope;
  label: string;
  items: readonly AnalysisNavigationItem[];
}

export const ANALYSIS_NAVIGATION: readonly AnalysisNavigationGroup[] = [
  {
    scope: "platform",
    label: "平台分析",
    items: [
      { routeId: "platform.overview.overview", label: "平台概览", icon: Gauge },
      { routeId: "platform.org-business.tenants", label: "组织", icon: EntityIcons.org },
      { routeId: "platform.org-business.users", label: "用户", icon: Users },
      { routeId: "platform.runtime.sessions", label: "会话", icon: MessageSquareText },
      { routeId: "platform.runtime.runs", label: "运行", icon: ListTree },
      { routeId: "platform.runtime.environments", label: "执行环境", icon: ServerCog },
      { routeId: "platform.runtime.infra", label: "系统资源", icon: HardDrive },
      { routeId: "platform.governance.audit", label: "操作记录", icon: EntityIcons.audit },
      { routeId: "platform.runtime.efficiency", label: "执行效率", icon: EntityIcons.analytics },
    ],
  },
  {
    scope: "organization",
    label: "组织分析",
    items: [
      { routeId: "organization.overview.overview", label: "综合分析", icon: Gauge },
      { routeId: "organization.governance.usage", label: "用量与计费", icon: EntityIcons.analytics },
      { routeId: "organization.governance.qa", label: "会话质检", icon: MessageSquareText },
      { routeId: "organization.governance.audit", label: "操作记录", icon: EntityIcons.audit },
    ],
  },
];

const ANALYSIS_ITEMS = ANALYSIS_NAVIGATION.flatMap((group) => group.items.map((item) => ({ ...item, scope: group.scope })));
const ANALYSIS_ITEMS_BY_ROUTE = new Map(ANALYSIS_ITEMS.map((item) => [item.routeId, item]));

export function getAnalysisNavigationItem(routeId: string | null | undefined) {
  return routeId ? ANALYSIS_ITEMS_BY_ROUTE.get(routeId) ?? null : null;
}

export function isAnalysisRoute(route: GovernanceRouteState | null | undefined): boolean {
  return getAnalysisNavigationItem(route?.routeId) !== null;
}

function platformScopeSearch(search: string | null | undefined): string {
  const current = new URLSearchParams(search ?? "");
  const next = new URLSearchParams();
  for (const key of ["tenantId", "userId"] as const) {
    const value = current.get(key);
    if (value) next.set(key, value);
  }
  const value = next.toString();
  return value ? `?${value}` : "";
}

export function analysisNavigationRoute(
  routeId: string,
  currentRoute: GovernanceRouteState | null | undefined,
  fallbackOrgId: string | null = null,
): GovernanceRouteState | null {
  const item = getAnalysisNavigationItem(routeId);
  if (!item) return null;
  return governanceRoute(routeId, {
    orgId: item.scope === "organization"
      ? (currentRoute?.area === "organization" ? currentRoute.orgId : fallbackOrgId)
      : null,
    search: item.scope === "platform" ? platformScopeSearch(currentRoute?.search) : "",
  });
}
