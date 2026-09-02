import type { SettingsDirtyController } from '@/components/PersonalSettings/dirtyRegistry';
import type { GovernanceRouteState } from '@/lib/governanceNavigation';
import { navigateSettingsRoute } from '@/lib/urlSync';
import { cn } from '@/lib/utils';
import {
  activeOrganizationLocalRouteId,
  organizationLocalRoute,
  organizationLocalRouteDefinitions,
} from './organizationManagementRouting';

export function OrganizationManagementLocalNav({
  route,
  dirtyController,
  className,
}: {
  route: GovernanceRouteState;
  dirtyController?: SettingsDirtyController;
  className?: string;
}) {
  const routes = organizationLocalRouteDefinitions(route);
  const activeRouteId = activeOrganizationLocalRouteId(route);
  const navigate = (routeId: string) => {
    const action = () => navigateSettingsRoute(organizationLocalRoute(route, routeId));
    if (dirtyController) dirtyController.requestNavigation(action);
    else action();
  };

  return (
    <nav
      className={cn(
        'flex shrink-0 gap-1 overflow-x-auto border-b bg-background px-4 py-2',
        className,
      )}
      aria-label="组织管理二级导航"
    >
      {routes.map((definition) => {
        const active = definition.id === activeRouteId;
        return (
          <button
            key={definition.id}
            type="button"
            className={cn(
              'whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors',
              active
                ? 'bg-foreground font-medium text-background'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
            aria-current={active ? 'page' : undefined}
            onClick={() => navigate(definition.id)}
          >
            {definition.label}
          </button>
        );
      })}
    </nav>
  );
}
