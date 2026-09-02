import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import type { ManagementSettingsAccess } from "@/hooks/useManagementSettingsAccess";
import type { GovernanceRouteState } from "@/lib/governanceNavigation";
import type { LayoutProps } from "@/layouts/types";

const CompanyInfoSectionPanel = lazy(() => import("@/components/CompanyInfoEditor").then((module) => ({ default: module.CompanyInfoSection })));
const CronManager = lazy(() => import("@/components/CronManager").then((module) => ({ default: module.CronManager })));
const EfficiencyViewPanel = lazy(() => import("@/components/UsageDashboard/EfficiencyView").then((module) => ({ default: module.EfficiencyView })));
const FileBrowser = lazy(() => import("@/components/FileBrowser").then((module) => ({ default: module.FileBrowser })));
const ManagementSettingsAccessGate = lazy(() => import("@/components/ManagementSettingsAccessGate").then((module) => ({ default: module.ManagementSettingsAccessGate })));
const McpAdminCatalogPanel = lazy(() => import("@/components/McpManager").then((module) => ({ default: module.McpAdminCatalog })));
const renderTenantMcpCatalog = (tenantId?: string) => <McpAdminCatalogPanel tenantId={tenantId} />;
const MemoryPollingManagerPanel = lazy(() => import("@/components/MemoryPollingManager").then((module) => ({ default: module.MemoryPollingManager })));
const ModelManagerPanel = lazy(() => import("@/components/ModelManager").then((module) => ({ default: module.ModelManager })));
const OrganizationScopeBanner = lazy(() => import("@/components/GovernanceConsole").then((module) => ({ default: module.OrganizationScopeBanner })));
const SettingsDirtyBoundary = lazy(() => import("@/components/PersonalSettings/dirtyRegistry").then((module) => ({ default: module.SettingsDirtyBoundary })));
const OrgAgentManagerPanel = lazy(() => import("@/components/OrgAgentManager").then((module) => ({ default: module.OrgAgentManager })));
const PlatformAdminShell = lazy(() => import("@/components/AdminShells").then((module) => ({ default: module.PlatformAdminShell })));
const SignupConfigManagerPanel = lazy(() => import("@/components/SignupConfigManager").then((module) => ({ default: module.SignupConfigManager })));
const SkillManagerPanel = lazy(() => import("@/components/SkillManager").then((module) => ({ default: module.SkillManager })));
const TenantAdminShell = lazy(() => import("@/components/AdminShells").then((module) => ({ default: module.TenantAdminShell })));
const TenantManager = lazy(() => import("@/components/TenantManager").then((module) => ({ default: module.TenantManager })));
const TenantRemoteHandsManagerPanel = lazy(() => import("@/components/TenantRemoteHandsManager").then((module) => ({ default: module.TenantRemoteHandsManager })));
const ToolControlsManagerPanel = lazy(() => import("@/components/ToolControlsManager").then((module) => ({ default: module.ToolControlsManager })));
const UsageDashboard = lazy(() => import("@/components/UsageDashboard").then((module) => ({ default: module.UsageDashboard })));
const UserManager = lazy(() => import("@/components/UserManager").then((module) => ({ default: module.UserManager })));

const fallback = (
  <div className="flex flex-1 items-center justify-center">
    <Loader2 className="size-6 animate-spin text-muted-foreground" />
  </div>
);

export function AnalysisWorkspaceContent({
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
  openFilePreview: LayoutProps["openFilePreview"];
  platformAdminSection: LayoutProps["platformAdminSection"];
  platformAdminEntityId: string | null;
  setPlatformAdminRoute: LayoutProps["setPlatformAdminRoute"];
}) {
  const { user } = useAuth();

  if (route.area === "organization") {
    return (
      <div className="absolute inset-0 z-30 min-h-0 overflow-hidden bg-card" data-testid="unified-analysis-content">
      <Suspense fallback={fallback}>
        <SettingsDirtyBoundary>{(dirtyController) => (
        <ManagementSettingsAccessGate scope="tenant" target="tenant" access={access} onRetry={access.retry} onReturnPersonal={onReturnPersonal}>
          <div className="flex h-full min-h-0 flex-col">
            <OrganizationScopeBanner route={route} dirtyController={dirtyController} />
            <div className="min-h-0 flex-1 overflow-hidden">
              <TenantAdminShell
                renderUsers={(tenantId, tenantName) => <UserManager tenantIdScope={tenantId} tenantName={tenantName} />}
                renderSkills={(tenantId, tenantName) => <SkillManagerPanel mode="tenant" tenantIdScope={tenantId} tenantName={tenantName} />}
                renderOrgAgents={(tenantId, tenantName) => <OrgAgentManagerPanel tenantId={tenantId} tenantName={tenantName} />}
                renderMcp={renderTenantMcpCatalog}
                renderUsage={(tenantId) => <UsageDashboard tenantId={tenantId} scope="tenant" fullWidth />}
                renderFiles={() => <FileBrowser onPreviewFile={openFilePreview} owner={user?.username} fullPage reserveCloseButtonSpace />}
                renderCompanyInfo={(tenantId, tenantName) => <CompanyInfoSectionPanel tenantId={tenantId} tenantName={tenantName} />}
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
            </div>
          </div>
        </ManagementSettingsAccessGate>)}</SettingsDirtyBoundary>
      </Suspense>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-30 min-h-0 overflow-hidden bg-card" data-testid="unified-analysis-content">
    <Suspense fallback={fallback}>
      <ManagementSettingsAccessGate scope="platform" target="platform" access={access} onRetry={access.retry} onReturnPersonal={onReturnPersonal}>
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
      </ManagementSettingsAccessGate>
    </Suspense>
    </div>
  );
}
