import { GOVERNANCE_NAVIGATION } from '@/lib/governanceNavigation';

export const ORGANIZATION_SETTINGS_WORKSPACE_IDS = [
  'overview',
  'members',
  'agents',
  'governance',
  'settings',
] as const;

export type OrganizationSettingsWorkspaceId = (typeof ORGANIZATION_SETTINGS_WORKSPACE_IDS)[number];
export type OrganizationSettingsWorkspaceIconKey =
  'overview' | 'members' | 'agents' | 'governance' | 'settings';

export interface OrganizationSettingsWorkspaceDefinition {
  id: OrganizationSettingsWorkspaceId;
  label: string;
  iconKey: OrganizationSettingsWorkspaceIconKey;
  defaultRouteId: string;
  routeIds: readonly string[];
}

const sourceById = new Map(
  GOVERNANCE_NAVIGATION.organization.map((workspace) => [workspace.id, workspace]),
);
const defaultRouteByWorkspace: Record<OrganizationSettingsWorkspaceId, string> = {
  overview: 'organization.overview.overview',
  members: 'organization.members.list',
  agents: 'organization.agents.org-agents',
  governance: 'organization.governance.usage',
  settings: 'organization.settings.profile',
};

/**
 * 设置中心组织管理的唯一一级导航投影。
 *
 * 叶子、文案和顺序仍由 GOVERNANCE_NAVIGATION 提供；这里只补充设置壳需要的图标与默认页，
 * 避免桌面、移动端和 renderer 分别维护第二份 23 页清单。
 */
export const ORGANIZATION_SETTINGS_WORKSPACES: readonly OrganizationSettingsWorkspaceDefinition[] =
  ORGANIZATION_SETTINGS_WORKSPACE_IDS.map((id) => {
    const source = sourceById.get(id);
    if (!source) throw new Error(`Missing organization governance workspace: ${id}`);
    const defaultRouteId = defaultRouteByWorkspace[id];
    if (
      !source.routes.some((route) => route.id === defaultRouteId && route.navigation !== 'detail')
    ) {
      throw new Error(`Invalid organization workspace default route: ${id} -> ${defaultRouteId}`);
    }
    return {
      id,
      label: source.label,
      iconKey: id,
      defaultRouteId,
      routeIds: source.routes.map((route) => route.id),
    };
  });

export const ORGANIZATION_MANAGEMENT_ROUTE_IDS = ORGANIZATION_SETTINGS_WORKSPACES.flatMap(
  (workspace) => workspace.routeIds,
);

export function organizationSettingsWorkspace(
  id: OrganizationSettingsWorkspaceId,
): OrganizationSettingsWorkspaceDefinition {
  const workspace = ORGANIZATION_SETTINGS_WORKSPACES.find((candidate) => candidate.id === id);
  if (!workspace) throw new Error(`Unknown organization settings workspace: ${id}`);
  return workspace;
}

export function organizationSettingsWorkspaceForRoute(
  routeId: string,
): OrganizationSettingsWorkspaceDefinition | null {
  return (
    ORGANIZATION_SETTINGS_WORKSPACES.find((workspace) => workspace.routeIds.includes(routeId)) ??
    null
  );
}

export function isOrganizationSettingsWorkspaceId(
  value: string,
): value is OrganizationSettingsWorkspaceId {
  return ORGANIZATION_SETTINGS_WORKSPACE_IDS.includes(value as OrganizationSettingsWorkspaceId);
}
