import {
  Activity,
  Gauge,
  HardDrive,
  ListTree,
  MessageSquareText,
  ServerCog,
  type LucideIcon,
} from 'lucide-react';

import { EntityIcons } from '@/lib/icons';
import {
  managementPageForRoute,
  managementPagesFor,
  managementRouteForPage,
  type ManagementPageDefinition,
} from '@/lib/managementNavigation';
import type { GovernanceRouteState } from '@/lib/governanceNavigation';

export type AnalysisScope = 'platform' | 'organization';

export interface AnalysisNavigationItem {
  pageId: string;
  routeId: string;
  label: string;
  icon: LucideIcon;
}

export interface AnalysisNavigationGroup {
  scope: AnalysisScope;
  label: string;
  items: readonly AnalysisNavigationItem[];
}

const icons: Readonly<Record<string, LucideIcon>> = {
  gauge: Gauge,
  wallet: EntityIcons.billing,
  message: MessageSquareText,
  workflow: ListTree,
  server: ServerCog,
  'hard-drive': HardDrive,
  activity: Activity,
  history: EntityIcons.audit,
  chart: EntityIcons.analytics,
};

function analysisItem(page: ManagementPageDefinition): AnalysisNavigationItem {
  return {
    pageId: page.id,
    routeId: page.routeId,
    label: page.label,
    icon: icons[page.iconKey] ?? EntityIcons.analytics,
  };
}

export const ANALYSIS_NAVIGATION: readonly AnalysisNavigationGroup[] = [
  {
    scope: 'platform',
    label: '平台分析',
    items: managementPagesFor('analytics', 'platform').map(analysisItem),
  },
  {
    scope: 'organization',
    label: '组织分析',
    items: managementPagesFor('analytics', 'organization').map(analysisItem),
  },
];

const ANALYSIS_ITEMS = ANALYSIS_NAVIGATION.flatMap((group) => group.items.map((item) => ({ ...item, scope: group.scope })));
const ANALYSIS_ITEMS_BY_ROUTE = new Map(ANALYSIS_ITEMS.map((item) => [item.routeId, item]));

export function getAnalysisNavigationItem(routeId: string | null | undefined) {
  return routeId ? ANALYSIS_ITEMS_BY_ROUTE.get(routeId) ?? null : null;
}

export function isAnalysisRoute(route: GovernanceRouteState | null | undefined): boolean {
  return managementPageForRoute(route)?.surface === 'analytics';
}

export function analysisNavigationRoute(
  routeId: string,
  currentRoute: GovernanceRouteState | null | undefined,
  fallbackOrgId: string | null = null,
): GovernanceRouteState | null {
  const page = managementPagesFor('analytics').find((candidate) => candidate.routeId === routeId);
  if (!page) return null;
  const route = managementRouteForPage(page, currentRoute, fallbackOrgId);
  if (page.area !== 'platform') return route;
  const current = new URLSearchParams(currentRoute?.search?.replace(/^\?/, '') ?? '');
  const preserved = new URLSearchParams();
  for (const key of ['tenantId', 'userId']) {
    const value = current.get(key);
    if (value) preserved.set(key, value);
  }
  const search = preserved.toString();
  return { ...route, search: search ? `?${search}` : '' };
}
