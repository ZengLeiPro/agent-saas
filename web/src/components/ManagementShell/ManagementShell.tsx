import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { OrganizationScopeBanner } from '@/components/GovernanceConsole';
import type { SettingsDirtyController } from '@/components/PersonalSettings/dirtyRegistry';
import type { ManagementSettingsAccess } from '@/hooks/useManagementSettingsAccess';
import {
  SETTINGS_CONTENT_WIDTH,
  SettingsPanelHeader,
  SettingsPanelHeaderPortalProvider,
} from '@/components/SettingsCenter/SettingsPanelHeader';
import {
  activeManagementTab,
  managementLayoutForPage,
  managementPageForRoute,
  managementPagesFor,
  managementRouteForPage,
  managementRouteForTab,
} from '@/lib/managementNavigation';
import { governanceCollectionRoute, type GovernanceRouteState } from '@/lib/governanceNavigation';
import { navigateGovernance } from '@/lib/urlSync';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
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

function detailTabDefinition(route: GovernanceRouteState): readonly string[] | null {
  if (!route.entityId || !route.tab) return null;
  if (route.routeId === 'organization.members.member') {
    return ['profile', 'access', 'assignments', 'usage-policy', 'security-audit'];
  }
  if (route.routeId === 'platform.org-business.tenants') {
    return ['overview', 'entitlements', 'resource-scope', 'billing', 'security-lifecycle'];
  }
  return null;
}

function handleTabKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
  count: number,
  activate: (index: number) => void,
) {
  const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    ? 1
    : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
      ? -1
      : event.key === 'Home'
        ? -index
        : event.key === 'End'
          ? count - index - 1
          : null;
  if (direction === null) return;
  event.preventDefault();
  const nextIndex = (index + direction + count) % count;
  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  activate(nextIndex);
}

function ManagementTabs({ route }: { route: GovernanceRouteState }) {
  const page = managementPageForRoute(route);
  if (!page) return null;
  const activeTab = activeManagementTab(page, route);
  if (!page.tabs?.length) return null;
  return (
    <div className="flex gap-6 overflow-x-auto border-b" role="tablist" aria-label={`${page.label}页面切换`}>
      {page.tabs.map((item, index) => {
        const selected = activeTab?.id === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`management-page-tab-${page.id}-${item.id}`}
            aria-controls="management-page-panel"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={cn(
              'relative -mb-px border-b-2 border-transparent px-0.5 pb-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
              selected && 'border-primary text-primary',
            )}
            onKeyDown={(event) => handleTabKeyDown(event, index, page.tabs!.length, (nextIndex) => {
              const next = page.tabs?.[nextIndex];
              if (next) navigateGovernance(managementRouteForTab(page, next.id, route));
            })}
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
  const definition = detailTabDefinition(route);
  if (!definition) return null;
  const activeTab = route.tab === 'configuration' ? 'entitlements' : route.tab;
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
          id={`management-detail-tab-${route.routeId}-${item}`}
          aria-controls="management-page-panel"
          aria-selected={activeTab === item}
          tabIndex={activeTab === item ? 0 : -1}
          className={cn(
            'relative -mb-px shrink-0 border-b-2 border-transparent px-0.5 pb-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
            (route.tab === 'configuration' ? 'entitlements' : route.tab) === item &&
              'border-primary text-primary',
          )}
          onKeyDown={(event) => handleTabKeyDown(event, definition.indexOf(item), definition.length, (nextIndex) => {
            const next = definition[nextIndex];
            if (next) navigateGovernance({ ...route, tab: next });
          })}
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
  const collectionRoute = governanceCollectionRoute(route);
  const layout = page ? managementLayoutForPage(page) : null;
  const detailTabs = detailTabDefinition(route);
  const activePageTab = page ? activeManagementTab(page, route) : null;
  const [headerActionsTarget, setHeaderActionsTarget] = useState<HTMLDivElement | null>(null);
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
      data-layout={layout ?? undefined}
      data-scroll-container="true"
    >
      <MobileManagementNavigation route={route} access={access} />
      <main className="px-4 py-5 md:px-8 md:py-6">
        <div className={cn('min-w-0', layout === 'form' ? SETTINGS_CONTENT_WIDTH : 'w-full')}>
          <SettingsPanelHeader
            title={page.label}
            description={page.description}
            actions={
              <div className="flex flex-wrap items-center justify-end gap-2">
                {collectionRoute ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => navigateGovernance(collectionRoute)}>
                    <ArrowLeft className="size-3.5" />
                    返回列表
                  </Button>
                ) : null}
                <div
                  ref={setHeaderActionsTarget}
                  className="flex flex-wrap items-center justify-end gap-2"
                  data-testid="management-page-actions"
                />
              </div>
            }
          />
          {route.area === 'organization' ? (
            <OrganizationScopeBanner
              route={route}
              dirtyController={dirtyController}
              settingsMode={page.surface === 'config'}
              className={page.tabs?.length ? 'mb-4 rounded-lg border' : undefined}
            />
          ) : null}
          <ManagementTabs route={route} />
          <DetailTabs route={route} />
          <div
            className="mt-6 min-w-0 [&>*]:mx-0 [&>*]:max-w-none"
            data-testid="management-page-content"
            id="management-page-panel"
            role={page.tabs?.length || detailTabs ? 'tabpanel' : undefined}
            tabIndex={page.tabs?.length || detailTabs ? 0 : undefined}
            aria-labelledby={detailTabs
              ? `management-detail-tab-${route.routeId}-${route.tab === 'configuration' ? 'entitlements' : route.tab}`
              : activePageTab
                ? `management-page-tab-${page.id}-${activePageTab.id}`
                : undefined}
          >
            <SettingsPanelHeaderPortalProvider target={headerActionsTarget}>
              {children}
            </SettingsPanelHeaderPortalProvider>
          </div>
        </div>
      </main>
    </div>
  );
}
