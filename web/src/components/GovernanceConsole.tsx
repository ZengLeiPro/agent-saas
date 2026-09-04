import { Suspense, useMemo, type ReactNode } from "react";
import {
  Activity,
  ChevronLeft,
  CircleGauge,
  Database,
  Loader2,
  LockKeyhole,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { AdminSelect } from "@/components/ui/admin-select";
import { EntityIcons } from "@/lib/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTenants } from "@/components/TenantManager/hooks";
import { useAuth } from "@/contexts/AuthContext";
import {
  GOVERNANCE_NAVIGATION,
  buildOrganizationSwitchUrl,
  filterCustomerOrganizations,
  governanceRoute,
  organizationSwitchRoute,
  type GovernanceArea,
  type GovernanceRouteDefinition,
  type GovernanceRouteState,
} from "@/lib/governanceNavigation";
import { navigateGovernance, navigateSettingsRoute, navigateToHref } from "@/lib/urlSync";
import { cn } from "@/lib/utils";
import type { SettingsDirtyController } from "@/components/PersonalSettings/dirtyRegistry";

export { getGovernanceUserMenuEntries } from "@/lib/governanceUserMenu";
export type { GovernanceUserMenuEntry } from "@/lib/governanceUserMenu";

const WORKSPACE_ICONS: Record<string, LucideIcon> = {
  overview: CircleGauge,
  "org-business": EntityIcons.org,
  "resource-center": Database,
  runtime: Activity,
  governance: EntityIcons.admin,
  members: EntityIcons.members,
  agents: EntityIcons.expert,
  settings: Settings2,
};

function navigateTo(route: GovernanceRouteState, replace = false) {
  navigateGovernance(route, { replace });
}

function routeForDefinition(definition: GovernanceRouteDefinition, current: GovernanceRouteState) {
  return governanceRoute(definition.id, {
    orgId: definition.area === "organization" ? current.orgId : null,
  });
}

function GovernancePageFallback() {
  return (
    <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground" data-testid="governance-page-loading">
      <Loader2 className="mr-2 size-4 animate-spin" />
      正在加载页面
    </div>
  );
}

export function GovernanceCapabilityNotice({
  title,
  mode = "unavailable",
  description,
}: {
  title: string;
  mode?: "unavailable" | "readonly";
  description?: string;
}) {
  const readOnly = mode === "readonly";
  return (
    <div className="mx-auto flex min-h-[360px] max-w-2xl items-center justify-center p-6">
      <div className="w-full rounded-2xl border border-dashed bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          {readOnly ? <LockKeyhole className="size-5" /> : <EntityIcons.toolControls className="size-5" />}
        </div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {description ?? (readOnly ? "当前能力仅提供只读查看，暂不支持在此修改。" : "能力尚未接入。当前没有可用页面或 API，不会展示模拟数据或产生假成功。")}
        </p>
        <Badge variant="outline" className="mt-4">{readOnly ? "只读" : "尚未接入"}</Badge>
      </div>
    </div>
  );
}

export function OrganizationScopeBanner({
  route,
  dirtyController,
  settingsMode = false,
}: {
  route: GovernanceRouteState;
  dirtyController?: SettingsDirtyController;
  settingsMode?: boolean;
}) {
  const { user, isPlatformAdmin } = useAuth();
  const { tenants } = useTenants();
  const organizations = useMemo(() => filterCustomerOrganizations(tenants), [tenants]);
  const currentId = route.orgId
    ?? (!isPlatformAdmin && user?.tenantId && filterCustomerOrganizations([{ id: user.tenantId }]).length ? user.tenantId : null)
    ?? null;
  const current = organizations.find((organization) => organization.id === currentId) ?? null;

  if (!isPlatformAdmin) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-300/70 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
      <EntityIcons.admin className="size-4 shrink-0" />
      <span className="font-medium">正在以平台管理员身份管理：{current?.name ?? currentId ?? "请选择组织"}</span>
      <AdminSelect
        ariaLabel="切换组织"
        size="sm"
        className="ml-auto w-48 max-w-full bg-background"
        options={[
          { value: "", label: "请选择目标组织" },
          ...organizations.map((organization) => ({ value: organization.id, label: organization.name })),
        ]}
        value={currentId ?? ""}
        placeholder="请选择目标组织"
        onValueChange={(nextId) => {
          if (!nextId || nextId === currentId) return;
          const switchOrganization = () => settingsMode
            ? navigateSettingsRoute(organizationSwitchRoute(route, nextId))
            : navigateToHref(buildOrganizationSwitchUrl(route, nextId));
          if (dirtyController) dirtyController.requestNavigation(switchOrganization);
          else switchOrganization();
        }}
      />
    </div>
  );
}

export function GovernanceConsole({
  area,
  route,
  children,
  onExit,
  dirtyController,
  className,
}: {
  area: Exclude<GovernanceArea, "settings">;
  route: GovernanceRouteState;
  children: ReactNode;
  onExit: () => void;
  dirtyController?: SettingsDirtyController;
  className?: string;
}) {
  const workspaces = GOVERNANCE_NAVIGATION[area];
  const workspace = workspaces.find((candidate) => candidate.id === route.workspace) ?? workspaces[0];
  const activeDefinition = workspace.routes.find((candidate) => candidate.id === route.routeId)
    ?? workspace.routes.find((candidate) => candidate.id === route.routeId)
    ?? workspace.routes[0];
  const title = area === "platform" ? "平台控制台" : "组织控制台";
  const requestNavigation = (navigation: () => void) => {
    if (dirtyController) dirtyController.requestNavigation(navigation);
    else navigation();
  };
  const navigateWithinConsole = (next: GovernanceRouteState) => requestNavigation(() => navigateTo(next));

  return (
    <div className={cn("flex h-full min-h-0 bg-muted/20", className)} data-testid={`${area}-console`}>
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-card md:flex">
        <div className="flex h-14 items-center gap-2 border-b px-3">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => requestNavigation(onExit)} aria-label="返回产品">
            <ChevronLeft className="size-4" />
          </Button>
          <span className="font-semibold">{title}</span>
        </div>
        <nav className="grid gap-1 p-3" aria-label={`${title}工作区`}>
          {workspaces.map((candidate) => {
            const Icon = WORKSPACE_ICONS[candidate.id] ?? CircleGauge;
            const active = candidate.id === workspace.id;
            return (
              <button
                key={candidate.id}
                type="button"
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                  active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                aria-current={active ? "page" : undefined}
                onClick={() => navigateWithinConsole(routeForDefinition(candidate.routes[0], route))}
              >
                <Icon className="size-4 shrink-0" />
                <span>{candidate.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b bg-card px-3 md:px-5">
          <Button variant="ghost" size="icon" className="size-8 md:hidden" onClick={() => requestNavigation(onExit)} aria-label="返回产品">
            <ChevronLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <div className="truncate text-xs text-muted-foreground">{workspace.label}</div>
            <h1 className="truncate text-base font-semibold">{activeDefinition.label}</h1>
          </div>
          <Badge variant="secondary" className="ml-auto shrink-0">{title}</Badge>
        </header>

        {area === "organization" && <OrganizationScopeBanner route={route} dirtyController={dirtyController} />}

        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b bg-background px-3 py-2 md:px-5" aria-label={`${workspace.label}本地导航`}>
          {workspace.routes.filter((definition) => definition.navigation !== "detail").map((definition) => {
            const active = definition.id === route.routeId || definition.id === activeDefinition.parentId;
            return (
              <button
                key={definition.id}
                type="button"
                className={cn(
                  "whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors",
                  active ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                aria-current={active ? "page" : undefined}
                onClick={() => navigateWithinConsole(routeForDefinition(definition, route))}
              >
                {definition.label}
              </button>
            );
          })}
        </nav>

        <main className="min-h-0 flex-1 overflow-auto">
          <Suspense fallback={<GovernancePageFallback />}>{children}</Suspense>
        </main>
      </section>
    </div>
  );
}

export function customerOrganizationSwitchUrl(current: GovernanceRouteState, nextOrgId: string) {
  return buildOrganizationSwitchUrl(current, nextOrgId);
}
