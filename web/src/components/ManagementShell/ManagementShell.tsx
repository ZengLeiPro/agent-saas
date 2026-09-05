import type { ReactNode } from 'react';
import { OrganizationScopeBanner } from '@/components/GovernanceConsole';
import type { SettingsDirtyController } from '@/components/PersonalSettings/dirtyRegistry';
import type { ManagementSettingsAccess } from '@/hooks/useManagementSettingsAccess';
import { SETTINGS_CONTENT_WIDTH } from '@/components/SettingsCenter/SettingsPanelHeader';
import {
  activeManagementTab,
  managementPageForRoute,
  managementPagesFor,
  managementRouteForPage,
  managementRouteForTab,
} from '@/lib/managementNavigation';
import type { GovernanceRouteState } from '@/lib/governanceNavigation';
import { navigateGovernance } from '@/lib/urlSync';
import { cn } from '@/lib/utils';
import { StateBlock } from './StateBlock';

const detailTabLabels: Readonly<Record<string, string>> = {
  profile: '资料',
  access: '权限',
  assignments: '资源指派',
  'usage-policy': '用量策略',
  'security-audit': '安全记录',
  overview: '概览',
  entitlements: '授权与配额',
  'resource-scope': '资源范围',
  billing: '计费',
  'security-lifecycle': '安全与生命周期',
};

function ManagementTabs({ route }: { route: GovernanceRouteState }) {
  const page = managementPageForRoute(route);
  if (!page) return null;
  const activeTab = activeManagementTab(page, route);
  if (!page.tabs?.length) return null;
  return (
    <div className="mt-5 flex gap-6 border-b" role="tablist" aria-label={`${page.label}页面切换`}>
      {page.tabs.map((item) => {
        const selected = activeTab?.id === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            className={cn(
              'relative -mb-px border-b-2 border-transparent px-0.5 pb-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
              selected && 'border-primary text-primary',
            )}
            onClick={() => navigateGovernance(managementRouteForTab(page, item.id, route))}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function DetailTabs({ route }: { route: GovernanceRouteState }) {
  if (!route.entityId || !route.tab) return null;
  const definition =
    route.routeId === 'organization.members.member'
      ? ['profile', 'access', 'assignments', 'usage-policy', 'security-audit']
      : route.routeId === 'platform.org-business.tenants'
        ? ['overview', 'entitlements', 'resource-scope', 'billing', 'security-lifecycle']
        : null;
  if (!definition) return null;
  return (
    <div
      className="mt-5 flex gap-6 overflow-x-auto border-b"
      role="tablist"
      aria-label="详情页面切换"
    >
      {definition.map((item) => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={(route.tab === 'configuration' ? 'entitlements' : route.tab) === item}
          className={cn(
            'relative -mb-px shrink-0 border-b-2 border-transparent px-0.5 pb-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
            (route.tab === 'configuration' ? 'entitlements' : route.tab) === item &&
              'border-primary text-primary',
          )}
          onClick={() => navigateGovernance({ ...route, tab: item })}
        >
          {detailTabLabels[item] ?? item}
        </button>
      ))}
    </div>
  );
}

function MobileManagementNavigation({
  route,
  access,
}: {
  route: GovernanceRouteState;
  access: ManagementSettingsAccess;
}) {
  const current = managementPageForRoute(route);
  if (!current) return null;
  const areas =
    current.area === 'platform' || !access.platformEntryAllowed
      ? [current.area]
      : (['organization', 'platform'] as const);
  const pages = areas.flatMap((area) => managementPagesFor(current.surface, area));
  return (
    <div className="border-b bg-card px-4 py-3 md:hidden">
      <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        当前页面
        <select
          className="h-10 rounded-lg border bg-background px-3 text-sm text-foreground"
          value={current.id}
          onChange={(event) => {
            const next = pages.find((page) => page.id === event.target.value);
            if (next) navigateGovernance(managementRouteForPage(next, route, route.orgId));
          }}
        >
          {pages.map((page) => (
            <option key={page.id} value={page.id}>
              {page.group} · {page.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function ManagementShell({
  route,
  access,
  dirtyController,
  children,
}: {
  route: GovernanceRouteState;
  access: ManagementSettingsAccess;
  dirtyController?: SettingsDirtyController;
  children: ReactNode;
}) {
  const page = managementPageForRoute(route);
  if (!page) {
    return (
      <div className="h-full overflow-hidden bg-muted/20 p-4 md:p-8">
        <StateBlock
          kind="error"
          title="这个管理页面无法打开"
          description="请从左侧管理导航重新选择页面。"
        />
      </div>
    );
  }

  return (
    <div
      className="h-full overflow-y-auto bg-muted/20"
      data-testid="management-shell"
      data-surface={page.surface}
      data-scroll-container="true"
    >
      <MobileManagementNavigation route={route} access={access} />
      <main className="px-4 py-5 md:px-8 md:py-6">
        <div className={SETTINGS_CONTENT_WIDTH}>
          {route.area === 'organization' ? (
            <OrganizationScopeBanner
              route={route}
              dirtyController={dirtyController}
              settingsMode={page.surface === 'config'}
            />
          ) : null}
          <ManagementTabs route={route} />
          <DetailTabs route={route} />
          <div className="mt-6" data-testid="management-page-content">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
