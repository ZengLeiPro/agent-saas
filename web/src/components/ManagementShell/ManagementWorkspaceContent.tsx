import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';

import { useAuth } from '@/contexts/AuthContext';
import type { ManagementSettingsAccess } from '@/hooks/useManagementSettingsAccess';
import type { GovernanceRouteState } from '@/lib/governanceNavigation';
import type { LayoutProps } from '@/layouts/types';
import { ManagementShell } from './ManagementShell';

const CompanyInfoSectionPanel = lazy(() =>
  import('@/components/CompanyInfoEditor').then((module) => ({
    default: module.CompanyInfoSection,
  })),
);
const CronManager = lazy(() =>
  import('@/components/CronManager').then((module) => ({ default: module.CronManager })),
);
const EfficiencyViewPanel = lazy(() =>
  import('@/components/UsageDashboard/EfficiencyView').then((module) => ({
    default: module.EfficiencyView,
  })),
);
const FileBrowser = lazy(() =>
  import('@/components/FileBrowser').then((module) => ({ default: module.FileBrowser })),
);
const ManagementSettingsAccessGate = lazy(() =>
  import('@/components/ManagementSettingsAccessGate').then((module) => ({
    default: module.ManagementSettingsAccessGate,
  })),
);
const McpAdminCatalogPanel = lazy(() =>
  import('@/components/McpManager').then((module) => ({ default: module.McpAdminCatalog })),
);
const MemoryPollingManagerPanel = lazy(() =>
  import('@/components/MemoryPollingManager').then((module) => ({
    default: module.MemoryPollingManager,
  })),
);
const ModelManagerPanel = lazy(() =>
  import('@/components/ModelManager').then((module) => ({ default: module.ModelManager })),
);
const SettingsDirtyBoundary = lazy(() =>
  import('@/components/PersonalSettings/dirtyRegistry').then((module) => ({
    default: module.SettingsDirtyBoundary,
  })),
);
const OrgAgentManagerPanel = lazy(() =>
  import('@/components/OrgAgentManager').then((module) => ({ default: module.OrgAgentManager })),
);
const PlatformAdminShell = lazy(() =>
  import('@/components/AdminShells').then((module) => ({ default: module.PlatformAdminShell })),
);
const SignupConfigManagerPanel = lazy(() =>
  import('@/components/SignupConfigManager').then((module) => ({
    default: module.SignupConfigManager,
  })),
);
const SkillManagerPanel = lazy(() =>
  import('@/components/SkillManager').then((module) => ({ default: module.SkillManager })),
);
const TenantAdminShell = lazy(() =>
  import('@/components/AdminShells').then((module) => ({ default: module.TenantAdminShell })),
);
const TenantManager = lazy(() =>
  import('@/components/TenantManager').then((module) => ({ default: module.TenantManager })),
);
const TenantRemoteHandsManagerPanel = lazy(() =>
  import('@/components/TenantRemoteHandsManager').then((module) => ({
    default: module.TenantRemoteHandsManager,
  })),
);
const ToolControlsManagerPanel = lazy(() =>
  import('@/components/ToolControlsManager').then((module) => ({
    default: module.ToolControlsManager,
  })),
);
const UsageDashboard = lazy(() =>
  import('@/components/UsageDashboard').then((module) => ({ default: module.UsageDashboard })),
);

const fallback = (
  <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
    <Loader2 className="mr-2 size-4 animate-spin" />
    正在加载管理页面…
  </div>
);

export function ManagementWorkspaceContent({
  route,
  access,
  onReturnPersonal,
  openFilePreview,
  platformAdminSection,
  platformAdminEntityId,
  setPlatformAdminRoute,
}: {
  route: GovernanceRouteState;
  access: ManagementSettingsAccess;
  onReturnPersonal: () => void;
  openFilePreview: LayoutProps['openFilePreview'];
  platformAdminSection: LayoutProps['platformAdminSection'];
  platformAdminEntityId: string | null;
  setPlatformAdminRoute: LayoutProps['setPlatformAdminRoute'];
}) {
  const { user } = useAuth();
  const target = route.area === 'organization' ? 'tenant' : 'platform';

  return (
    <div
      className="absolute inset-0 z-30 min-h-0 overflow-hidden bg-card"
      data-testid="unified-management-content"
    >
      <Suspense fallback={fallback}>
        <SettingsDirtyBoundary>
          {(dirtyController) => (
            <ManagementSettingsAccessGate
              scope={target}
              target={target}
              access={access}
              onRetry={access.retry}
              onReturnPersonal={onReturnPersonal}
            >
              <ManagementShell route={route} access={access} dirtyController={dirtyController}>
                {route.area === 'organization' ? (
                  <TenantAdminShell
                    renderUsers={() => null}
                    renderSkills={(tenantId, tenantName) => (
                      <SkillManagerPanel
                        mode="tenant"
                        tenantIdScope={tenantId}
                        tenantName={tenantName}
                      />
                    )}
                    renderOrgAgents={(tenantId, tenantName) => (
                      <OrgAgentManagerPanel tenantId={tenantId} tenantName={tenantName} />
                    )}
                    renderMcp={(tenantId) => <McpAdminCatalogPanel tenantId={tenantId} />}
                    renderUsage={(tenantId) => (
                      <UsageDashboard tenantId={tenantId} scope="tenant" fullWidth />
                    )}
                    renderFiles={() => (
                      <FileBrowser
                        onPreviewFile={openFilePreview}
                        owner={user?.username}
                        fullPage
                        reserveCloseButtonSpace
                      />
                    )}
                    renderCompanyInfo={(tenantId, tenantName) => (
                      <CompanyInfoSectionPanel tenantId={tenantId} tenantName={tenantName} />
                    )}
                    renderAutomation={() => <CronManager />}
                    settingsOpen={false}
                    settingsSection="users"
                    onSettingsSectionChange={() => undefined}
                    onSettingsClose={() => undefined}
                    governanceRoute={route}
                    governanceContentOnly
                    governanceContentEmbedded
                    dirtyController={dirtyController}
                  />
                ) : (
                  <PlatformAdminShell
                    renderTenants={() => <TenantManager />}
                    renderSignupConfig={() => <SignupConfigManagerPanel />}
                    renderModels={() => <ModelManagerPanel />}
                    renderRemoteHands={() => <TenantRemoteHandsManagerPanel />}
                    renderToolControls={() => <ToolControlsManagerPanel />}
                    renderMemoryPolling={() => <MemoryPollingManagerPanel />}
                    renderMcp={() => <McpAdminCatalogPanel />}
                    renderSkills={() => <SkillManagerPanel mode="platform" />}
                    renderEfficiency={() => <EfficiencyViewPanel />}
                    activeSection={platformAdminSection}
                    entityId={platformAdminEntityId}
                    onSectionChange={setPlatformAdminRoute}
                    settingsOpen={false}
                    settingsSection="tenants"
                    onSettingsSectionChange={() => undefined}
                    onSettingsClose={() => undefined}
                    governanceRoute={route}
                    governanceContentOnly
                    governanceContentEmbedded
                  />
                )}
              </ManagementShell>
            </ManagementSettingsAccessGate>
          )}
        </SettingsDirtyBoundary>
      </Suspense>
    </div>
  );
}
