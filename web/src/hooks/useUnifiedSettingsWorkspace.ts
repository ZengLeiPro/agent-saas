import { useCallback, useRef } from "react";

import type { SettingsDirtyController } from "@/components/PersonalSettings/dirtyRegistry";
import type { OrganizationSettingsWorkspaceId } from "@/components/OrganizationManagement/organizationManagementRegistry";
import type { GovernanceRouteState } from "@/lib/governanceNavigation";
import {
  managementPageById,
  managementPageForRoute,
  managementRouteForPage,
} from '@/lib/managementNavigation';
import { navigateSettingsRoute, type AdminSettingsState, type AdminSettingsTarget } from "@/lib/urlSync";
import type { SettingsSectionId } from "@/types/settings";

export function useUnifiedSettingsWorkspace({
  settingsOpen,
  settingsSection,
  adminSettings,
  openSettings,
  closeSettings,
  setSettingsSection,
  openAdminSettings,
  closeAdminSettings,
  setAdminSettingsSection,
  isPlatformAdmin,
  organizationSettingsTargetId,
  governanceRoute,
  closeOrganizationSettings,
}: {
  settingsOpen: boolean;
  settingsSection: SettingsSectionId;
  adminSettings: AdminSettingsState | null;
  openSettings: (section?: SettingsSectionId) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSectionId) => void;
  openAdminSettings: (target: AdminSettingsTarget, section?: string) => void;
  closeAdminSettings: () => void;
  setAdminSettingsSection: (section: string) => void;
  isPlatformAdmin: boolean;
  /** undefined=Tenant Shell 尚未报告；null=平台管理员明确未选择组织。 */
  organizationSettingsTargetId?: string | null;
  governanceRoute?: GovernanceRouteState | null;
  closeOrganizationSettings?: () => void;
}) {
  const managementPage = managementPageForRoute(governanceRoute);
  const configRoute = managementPage?.surface === 'config' ? governanceRoute ?? null : null;
  const mode = settingsOpen || adminSettings !== null || configRoute !== null;
  const target = configRoute
    ? (configRoute.area === 'organization' ? 'tenant' as const : 'platform' as const)
    : settingsOpen ? "personal" as const : adminSettings?.target ?? "personal";
  const activeSection = configRoute && managementPage
    ? managementPage.id
    : (settingsOpen ? settingsSection : adminSettings?.section ?? "account-security");
  const dirtyControllerRef = useRef<SettingsDirtyController | null>(null);
  const onControllerChange = useCallback((controller: SettingsDirtyController | null) => {
    dirtyControllerRef.current = controller;
  }, []);
  const requestNavigation = useCallback((navigation: () => void) => {
    const controller = dirtyControllerRef.current;
    if (controller) controller.requestNavigation(navigation);
    else navigation();
  }, []);
  const navigate = useCallback((nextTarget: "personal" | AdminSettingsTarget, section: string) => {
    requestNavigation(() => {
      if (nextTarget === "personal") {
        if (settingsOpen) setSettingsSection(section as SettingsSectionId);
        else openSettings(section as SettingsSectionId);
      } else if (nextTarget === "tenant") {
        const page = managementPageById(section);
        const orgId = governanceRoute?.area === 'organization'
          ? (governanceRoute.orgId ?? (isPlatformAdmin ? organizationSettingsTargetId ?? null : null))
          : (isPlatformAdmin ? organizationSettingsTargetId ?? null : null);
        if (page?.surface === 'config' && page.area === 'organization') {
          navigateSettingsRoute(managementRouteForPage(page, governanceRoute, orgId));
          return;
        }
        void import("@/components/OrganizationManagement/organizationManagementRouting")
          .then(({ organizationWorkspaceRoute }) => {
            navigateSettingsRoute({
              ...organizationWorkspaceRoute(
                section as OrganizationSettingsWorkspaceId,
                governanceRoute?.area === 'organization' ? governanceRoute : null,
              ),
              orgId,
            });
          });
      } else {
        const page = managementPageById(section);
        if (page?.surface === 'config' && page.area === 'platform') {
          navigateSettingsRoute(managementRouteForPage(page, governanceRoute));
        } else if (adminSettings?.target === nextTarget) setAdminSettingsSection(section);
        else openAdminSettings(nextTarget, section);
      }
    });
  }, [adminSettings?.target, governanceRoute, isPlatformAdmin, openAdminSettings, openSettings, organizationSettingsTargetId, requestNavigation, setAdminSettingsSection, setSettingsSection, settingsOpen]);
  const close = useCallback(() => {
    requestNavigation(configRoute?.area === 'organization' && closeOrganizationSettings
      ? closeOrganizationSettings
      : settingsOpen ? closeSettings : closeAdminSettings);
  }, [closeAdminSettings, closeOrganizationSettings, closeSettings, configRoute, requestNavigation, settingsOpen]);
  const open = useCallback((section: SettingsSectionId = "account-security") => {
    if (mode) navigate("personal", section);
    else openSettings(section);
  }, [mode, navigate, openSettings]);
  return { mode, target, activeSection, navigate, close, open, guardNavigation: requestNavigation, onControllerChange };
}
