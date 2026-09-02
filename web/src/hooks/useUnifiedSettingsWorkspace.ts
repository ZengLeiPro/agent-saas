import { useCallback, useRef } from "react";

import type { SettingsDirtyController } from "@/components/PersonalSettings/dirtyRegistry";
import type { GovernanceRouteState } from "@/lib/governanceNavigation";
import { navigateSettingsRoute, type AdminSettingsState, type AdminSettingsTarget } from "@/lib/urlSync";
import type { SettingsSectionId } from "@/types/settings";
import {
  isOrganizationSettingsWorkspaceId,
  organizationSettingsWorkspaceForRoute,
} from "@/components/OrganizationManagement/organizationManagementRegistry";
import { organizationWorkspaceRoute } from "@/components/OrganizationManagement/organizationManagementRouting";

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
  const organizationRoute = governanceRoute?.area === "organization" ? governanceRoute : null;
  const organizationWorkspace = organizationRoute
    ? organizationSettingsWorkspaceForRoute(organizationRoute.routeId)
    : null;
  const mode = settingsOpen || adminSettings !== null || organizationRoute !== null;
  const target = organizationRoute ? "tenant" as const : settingsOpen ? "personal" as const : adminSettings?.target ?? "personal";
  const activeSection = organizationWorkspace?.id
    ?? (settingsOpen ? settingsSection : adminSettings?.section ?? "account-security");
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
        if (!isOrganizationSettingsWorkspaceId(section)) {
          throw new Error(`Unknown organization settings workspace: ${section}`);
        }
        const orgId = organizationRoute?.orgId
          ?? (isPlatformAdmin ? organizationSettingsTargetId ?? null : null);
        const nextRoute = organizationWorkspaceRoute(section, organizationRoute);
        navigateSettingsRoute({ ...nextRoute, orgId });
      } else if (adminSettings?.target === nextTarget) setAdminSettingsSection(section);
      else openAdminSettings(nextTarget, section);
    });
  }, [adminSettings?.target, isPlatformAdmin, openAdminSettings, openSettings, organizationRoute, organizationSettingsTargetId, requestNavigation, setAdminSettingsSection, setSettingsSection, settingsOpen]);
  const close = useCallback(() => {
    requestNavigation(organizationRoute && closeOrganizationSettings
      ? closeOrganizationSettings
      : settingsOpen ? closeSettings : closeAdminSettings);
  }, [closeAdminSettings, closeOrganizationSettings, closeSettings, organizationRoute, requestNavigation, settingsOpen]);
  const open = useCallback((section: SettingsSectionId = "account-security") => {
    if (mode) navigate("personal", section);
    else openSettings(section);
  }, [mode, navigate, openSettings]);
  return { mode, target, activeSection, navigate, close, open, guardNavigation: requestNavigation, onControllerChange };
}
