import { OrganizationSystemsPage } from '@/components/BusinessSystems/OrganizationSystemsPage';
import { KyAppTenantUsagePanel } from '@/components/KyAppDeliveryPanels';
import { lazy, Suspense, type ReactNode } from 'react';

import { GovernanceCapabilityNotice } from '@/components/GovernanceConsole';
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
import {
  OrganizationCatalogAccessPanel,
  OrganizationEntitlementScopeEditor,
} from '@/components/OrganizationGovernance/ResourceAccessEditors';
import type { SettingsDirtyController } from '@/components/PersonalSettings/dirtyRegistry';
import { QaConsole } from '@/components/QaConsole';
import { GovernanceChangeAuditPage } from '@/components/Governance/GovernanceChangeAuditPage';
import { TenantSettingsPanel } from '@/components/TenantSettingsPanel';
import { OverviewSection as TenantOverviewSection } from '@/components/TenantAnalytics/OverviewSection';
import type { GovernanceRouteState } from '@/lib/governanceNavigation';
import { governanceRoute } from '@/lib/governanceNavigation';
import { organizationRouteDefinition } from './organizationManagementRouting';

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
  renderMcpCatalog: (tenantId: string, tenantName?: string) => ReactNode;
  renderUsage: (tenantId: string) => ReactNode;
  renderFiles: (tenantId: string, tenantName?: string) => ReactNode;
  renderCompanyInfo: (tenantId: string, tenantName?: string) => ReactNode;
  renderAutomation?: (tenantId: string, tenantName?: string) => ReactNode;
}

type OrganizationManagementRenderer = (context: OrganizationManagementRendererContext) => ReactNode;

/**
 * 组织管理唯一 renderer 表。测试会把这些 key 与 Governance organization routes 做集合比对，
 * 新增 route 却未接页面时直接失败，不允许静默落回旧设置页或模拟数据。
 */
export const ORGANIZATION_MANAGEMENT_RENDERERS: Readonly<
  Record<string, OrganizationManagementRenderer>
> = {
  'organization.agents.business-systems': ({ tenantId, route }) => <OrganizationSystemsPage key={tenantId} tenantId={tenantId} installationId={route.entityId} />,
  'organization.governance.business-system-usage': ({ tenantId }) => <KyAppTenantUsagePanel key={tenantId} tenantId={tenantId} />,
  'organization.overview.overview': ({ tenantId }) => <TenantOverviewSection tenantId={tenantId} />,
  'organization.members.list': ({ tenantId, route }) => (
    <OrganizationMembersPage tenantId={tenantId} route={route} />
  ),
  'organization.members.accounts': ({ tenantId }) => (
    <OrganizationMembersPage
      tenantId={tenantId}
      route={governanceRoute('organization.members.list', { orgId: tenantId })}
    />
  ),
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
  'organization.agents.org-agents': ({ tenantId, tenantName, renderOrgAgents, route }) => (
    new URLSearchParams(route.search?.replace(/^\?/, '')).get('view') === 'templates'
      ? <OrganizationEntitlementScopeEditor tenantId={tenantId} resourceType="agent_template" title="智能体模板可用范围" description="控制平台智能体模板是否可被本组织创建和使用。" />
      : renderOrgAgents?.(tenantId, tenantName) ?? <GovernanceCapabilityNotice title="组织智能体" />
  ),
  'organization.agents.workflows': ({ tenantId }) => (
    <WorkflowDisplaySettingsPage tenantId={tenantId} />
  ),
  'organization.agents.dingtalk-accounts': ({ tenantId }) => (
    <AgentDwsAccountsPage tenantId={tenantId} />
  ),
  'organization.agents.skills': ({ tenantId, tenantName, renderSkills, route }) => (
    new URLSearchParams(route.search?.replace(/^\?/, '')).get('view') === 'access'
      ? <OrganizationCatalogAccessPanel tenantId={tenantId} resourceType="skill" scopeTitle="平台技能可用范围" assignmentTitle="技能成员与群组授权" />
      : renderSkills(tenantId, tenantName)
  ),
  'organization.agents.connectors': ({ tenantId }) => (
    <OrganizationCredentialsPage tenantId={tenantId} />
  ),
  'organization.agents.mcp-catalog': ({ tenantId, tenantName, renderMcpCatalog }) =>
    renderMcpCatalog(tenantId, tenantName),
  'organization.agents.connector-mappings': ({ tenantId, tenantName }) => (
    <TenantConnectorDictionaryPanel tenantId={tenantId} tenantName={tenantName} />
  ),
  'organization.agents.memory-knowledge': ({ tenantId }) => (
    <OrganizationMemoryKnowledgePage tenantId={tenantId} />
  ),
  'organization.agents.files-data': ({ tenantId, tenantName, renderFiles }) => renderFiles(tenantId, tenantName),
  'organization.agents.model-tools': ({ tenantId, route }) => {
    const view = new URLSearchParams(route.search?.replace(/^\?/, '')).get('view');
    if (view === 'tools') return <OrganizationEntitlementScopeEditor tenantId={tenantId} resourceType="tool" title="工具可用范围" description="控制平台工具进入本组织的范围。" />;
    if (view === 'defaults') return <TenantSettingsPanel tenantId={tenantId} section="model-tools" />;
    return <OrganizationEntitlementScopeEditor tenantId={tenantId} resourceType="model" title="模型可用范围" description="控制平台模型进入本组织的范围；默认模型在“默认策略”中配置。" />;
  },
  'organization.agents.environments': ({ tenantId }) => (
    <OrganizationEnvironmentsPage tenantId={tenantId} />
  ),
  'organization.governance.automation': ({ tenantId, tenantName, renderAutomation }) =>
    renderAutomation?.(tenantId, tenantName) ?? <GovernanceCapabilityNotice title="自动化任务" />,
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
  renderMcpCatalog: (tenantId: string, tenantName?: string) => ReactNode;
  renderUsage: (tenantId: string) => ReactNode;
  renderFiles: (tenantId: string, tenantName?: string) => ReactNode;
  renderCompanyInfo: (tenantId: string, tenantName?: string) => ReactNode;
  renderAutomation?: (tenantId: string, tenantName?: string) => ReactNode;
  dirtyController?: SettingsDirtyController;
  embedded?: boolean;
}

export function OrganizationManagementContent(props: OrganizationManagementContentProps) {
  const { route } = props;
  const definition = organizationRouteDefinition(route.routeId);
  const renderer = ORGANIZATION_MANAGEMENT_RENDERERS[route.routeId];

  if (route.area !== 'organization' || !definition || !renderer) {
    return <GovernanceCapabilityNotice title="组织管理页面不可用" />;
  }

  return <div data-testid="organization-management-content"><Suspense fallback={<OrganizationPageFallback />}>{renderer(props)}</Suspense></div>;
}
