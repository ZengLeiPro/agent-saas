import {
  GOVERNANCE_ROUTES,
  governanceRoute,
  type GovernanceRouteDefinition,
  type GovernanceRouteState,
} from '@/lib/governanceNavigation';
import {
  organizationSettingsWorkspace,
  organizationSettingsWorkspaceForRoute,
  type OrganizationSettingsWorkspaceId,
} from './organizationManagementRegistry';

const organizationDefinitionsById = new Map(
  GOVERNANCE_ROUTES.filter((definition) => definition.area === 'organization').map((definition) => [
    definition.id,
    definition,
  ]),
);

export function organizationRouteDefinition(routeId: string): GovernanceRouteDefinition {
  const definition = organizationDefinitionsById.get(routeId);
  if (!definition) throw new Error(`Unknown organization management route: ${routeId}`);
  return definition;
}

export function organizationWorkspaceRoute(
  workspaceId: OrganizationSettingsWorkspaceId,
  current?: GovernanceRouteState | null,
  fallbackOrgId?: string | null,
): GovernanceRouteState {
  const workspace = organizationSettingsWorkspace(workspaceId);
  return governanceRoute(workspace.defaultRouteId, {
    orgId: current?.area === 'organization' ? current.orgId : fallbackOrgId ?? null,
  });
}

export function organizationLocalRoute(
  current: GovernanceRouteState,
  routeId: string,
): GovernanceRouteState {
  const definition = organizationRouteDefinition(routeId);
  if (definition.navigation === 'detail') {
    throw new Error(`Detail route cannot be used as local navigation target: ${routeId}`);
  }
  return governanceRoute(routeId, { orgId: current.orgId });
}

export function activeOrganizationLocalRouteId(route: GovernanceRouteState): string {
  const definition = organizationRouteDefinition(route.routeId);
  return definition.parentId ?? definition.id;
}

export function organizationLocalRouteDefinitions(
  route: GovernanceRouteState,
): readonly GovernanceRouteDefinition[] {
  const workspace = organizationSettingsWorkspaceForRoute(route.routeId);
  if (!workspace) throw new Error(`Route is outside organization settings: ${route.routeId}`);
  return workspace.routeIds
    .map(organizationRouteDefinition)
    .filter((definition) => definition.navigation !== 'detail');
}
