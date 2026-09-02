import { lazy, Suspense, type ReactNode } from 'react';

import {
  GovernanceCapabilityNotice,
  OrganizationScopeBanner,
} from '@/components/GovernanceConsole';
import {
  OrganizationCredentialsPage,
  OrganizationEnvironmentsPage,
  OrganizationGroupsPage,
  OrganizationMemoryKnowledgePage,
  OrganizationMembersPage,
  OrganizationOffboardingPage,
  OrganizationPoliciesPage,
} from '@/components/OrganizationGovernance/OrganizationGovernancePage';
import { OrganizationUsageBillingPage } from '@/components/OrganizationGovernance/OrganizationUsageBillingPage';
import type { SettingsDirtyController } from '@/components/PersonalSettings/dirtyRegistry';
import { QaConsole } from '@/components/QaConsole';
import { GovernanceChangeAuditPage } from '@/components/Governance/GovernanceChangeAuditPage';
import { TenantSettingsPanel } from '@/components/TenantSettingsPanel';
import { OverviewSection as TenantOverviewSection } from '@/components/TenantAnalytics/OverviewSection';
import type { GovernanceRouteState } from '@/lib/governanceNavigation';
import { OrganizationManagementLocalNav } from './OrganizationManagementLocalNav';
import { organizationRouteDefinition } from './organizationManagementRouting';
import { organizationSettingsWorkspaceForRoute } from './organizationManagementRegistry';

const AgentDwsAccountsPage = lazy(() => import('@/components/AgentDwsAccounts'));
const TenantConnectorDictionaryPanel = lazy(
  () => import('@/components/ConnectorDictionaryManager/TenantPanel'),
);
const TenantInstructionsPanel = lazy(() =>
  import('@/components/TenantInstructionsEditor').then((module) => ({
    default: module.TenantInstructionsSection,
  })),
);
const WorkflowDisplaySettingsPage = lazy(() => import('@/components/WorkflowDisplaySettingsPage'));

interface OrganizationManagementRendererContext {
  route: GovernanceRouteState;
  tenantId: string;
  tenantName?: string;
  renderAccounts: (tenantId: string, tenantName?: string) => ReactNode;
  renderOrgAgents?: (tenantId: string, tenantName?: string) => ReactNode;
  renderSkills: (tenantId: string, tenantName?: string) => ReactNode;
  renderMcpCatalog: () => ReactNode;
  renderUsage: (tenantId: string) => ReactNode;
  renderFiles: () => ReactNode;
  renderCompanyInfo: (tenantId: string, tenantName?: string) => ReactNode;
  renderAutomation?: () => ReactNode;
}

type OrganizationManagementRenderer = (context: OrganizationManagementRendererContext) => ReactNode;

/**
 * 组织管理唯一 renderer 表。测试会把这些 key 与 Governance organization routes 做集合比对，
 * 新增 route 却未接页面时直接失败，不允许静默落回旧设置页或模拟数据。
 */
export const ORGANIZATION_MANAGEMENT_RENDERERS: Readonly<
  Record<string, OrganizationManagementRenderer>
> = {
  'organization.overview.overview': ({ tenantId }) => <TenantOverviewSection tenantId={tenantId} />,
  'organization.members.list': ({ tenantId, route }) => (
    <OrganizationMembersPage tenantId={tenantId} route={route} />
  ),
  'organization.members.accounts': ({ tenantId, tenantName, renderAccounts }) =>
    renderAccounts(tenantId, tenantName),
  'organization.members.owners': ({ tenantId, route }) => (
    <OrganizationMembersPage tenantId={tenantId} route={route} />
  ),
  'organization.members.member': ({ tenantId, route }) => (
    <OrganizationMembersPage tenantId={tenantId} route={route} />
  ),
  'organization.members.policies': ({ tenantId }) => (
    <OrganizationPoliciesPage tenantId={tenantId} />
  ),
  'organization.members.groups': ({ tenantId }) => <OrganizationGroupsPage tenantId={tenantId} />,
  'organization.members.offboarding': ({ tenantId }) => (
    <OrganizationOffboardingPage tenantId={tenantId} />
  ),
  'organization.agents.org-agents': ({ tenantId, tenantName, renderOrgAgents }) =>
    renderOrgAgents?.(tenantId, tenantName) ?? <GovernanceCapabilityNotice title="组织智能体" />,
  'organization.agents.workflows': ({ tenantId }) => (
    <WorkflowDisplaySettingsPage tenantId={tenantId} />
  ),
  'organization.agents.dingtalk-accounts': ({ tenantId }) => (
    <AgentDwsAccountsPage tenantId={tenantId} />
  ),
  'organization.agents.skills': ({ tenantId, tenantName, renderSkills }) =>
    renderSkills(tenantId, tenantName),
  'organization.agents.connectors': ({ tenantId }) => (
    <OrganizationCredentialsPage tenantId={tenantId} />
  ),
  'organization.agents.mcp-catalog': ({ renderMcpCatalog }) => renderMcpCatalog(),
  'organization.agents.connector-mappings': ({ tenantId, tenantName }) => (
    <TenantConnectorDictionaryPanel tenantId={tenantId} tenantName={tenantName} />
  ),
  'organization.agents.memory-knowledge': ({ tenantId }) => (
    <OrganizationMemoryKnowledgePage tenantId={tenantId} />
  ),
  'organization.agents.files-data': ({ renderFiles }) => renderFiles(),
  'organization.agents.model-tools': ({ tenantId }) => (
    <TenantSettingsPanel tenantId={tenantId} section="model-tools" />
  ),
  'organization.agents.environments': ({ tenantId }) => (
    <OrganizationEnvironmentsPage tenantId={tenantId} />
  ),
  'organization.governance.automation': ({ renderAutomation }) =>
    renderAutomation?.() ?? <GovernanceCapabilityNotice title="自动化任务" />,
  'organization.governance.usage': ({ tenantId, tenantName, renderUsage }) => (
    <OrganizationUsageBillingPage
      tenantId={tenantId}
      tenantName={tenantName}
      usage={renderUsage(tenantId)}
    />
  ),
  'organization.governance.qa': ({ tenantId }) => <QaConsole tenantId={tenantId} />,
  'organization.governance.audit': ({ tenantId }) => (
    <GovernanceChangeAuditPage tenantId={tenantId} />
  ),
  'organization.settings.profile': ({ tenantId, tenantName, renderCompanyInfo }) =>
    renderCompanyInfo(tenantId, tenantName),
  'organization.settings.rules': ({ tenantId, tenantName }) => (
    <TenantInstructionsPanel tenantId={tenantId} tenantName={tenantName} />
  ),
  'organization.settings.general': ({ tenantId }) => (
    <TenantSettingsPanel tenantId={tenantId} section="general" />
  ),
  'organization.settings.brand': ({ tenantId }) => (
    <TenantSettingsPanel tenantId={tenantId} section="brand" />
  ),
  'organization.settings.security': ({ tenantId }) => (
    <TenantSettingsPanel tenantId={tenantId} section="security" />
  ),
};

function OrganizationPageFallback() {
  return (
    <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
      正在加载组织管理页面…
    </div>
  );
}

export interface OrganizationManagementContentProps {
  route: GovernanceRouteState;
  tenantId: string;
  tenantName?: string;
  renderAccounts: (tenantId: string, tenantName?: string) => ReactNode;
  renderOrgAgents?: (tenantId: string, tenantName?: string) => ReactNode;
  renderSkills: (tenantId: string, tenantName?: string) => ReactNode;
  renderMcpCatalog: () => ReactNode;
  renderUsage: (tenantId: string) => ReactNode;
  renderFiles: () => ReactNode;
  renderCompanyInfo: (tenantId: string, tenantName?: string) => ReactNode;
  renderAutomation?: () => ReactNode;
  dirtyController?: SettingsDirtyController;
}

export function OrganizationManagementContent(props: OrganizationManagementContentProps) {
  const { route, tenantId, tenantName, dirtyController } = props;
  const workspace = organizationSettingsWorkspaceForRoute(route.routeId);
  const definition = workspace ? organizationRouteDefinition(route.routeId) : null;
  const renderer = ORGANIZATION_MANAGEMENT_RENDERERS[route.routeId];

  if (route.area !== 'organization' || !workspace || !definition || !renderer) {
    return <GovernanceCapabilityNotice title="组织管理页面不可用" />;
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-card"
      data-testid="organization-management-content"
    >
      <header className="shrink-0 border-b px-4 py-3 md:px-6">
        <div className="text-xs text-muted-foreground">
          {tenantName ?? tenantId} / {workspace.label}
        </div>
        <h1 className="mt-0.5 text-base font-semibold">{definition.label}</h1>
      </header>
      <OrganizationScopeBanner route={route} dirtyController={dirtyController} settingsMode />
      <OrganizationManagementLocalNav route={route} dirtyController={dirtyController} />
      <main className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        <Suspense fallback={<OrganizationPageFallback />}>{renderer(props)}</Suspense>
      </main>
    </div>
  );
}
