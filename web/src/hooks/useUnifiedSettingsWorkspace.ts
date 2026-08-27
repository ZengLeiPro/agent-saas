import { useCallback, useRef } from "react";

import type { SettingsDirtyController } from "@/components/PersonalSettings/dirtyRegistry";
import { governanceRoute } from "@/lib/governanceNavigation";
import { navigateGovernance, type AdminSettingsState, type AdminSettingsTarget } from "@/lib/urlSync";
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
}) {
  const mode = settingsOpen || adminSettings !== null;
  const target = settingsOpen ? "personal" as const : adminSettings?.target ?? "personal";
  const activeSection = settingsOpen ? settingsSection : adminSettings?.section ?? "account-security";
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
      } else if (adminSettings?.target === nextTarget) setAdminSettingsSection(section);
      else openAdminSettings(nextTarget, section);
    });
  }, [adminSettings?.target, openAdminSettings, openSettings, requestNavigation, setAdminSettingsSection, setSettingsSection, settingsOpen]);
  const close = useCallback(() => {
    requestNavigation(settingsOpen ? closeSettings : closeAdminSettings);
  }, [closeAdminSettings, closeSettings, requestNavigation, settingsOpen]);
  const open = useCallback((section: SettingsSectionId = "account-security") => {
    if (mode) navigate("personal", section);
    else openSettings(section);
  }, [mode, navigate, openSettings]);
  const openOrganizationGovernance = useCallback(() => {
    const orgId = isPlatformAdmin && typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("org")
      : null;
    requestNavigation(() => navigateGovernance(governanceRoute(
      "organization.members.list",
      orgId ? { orgId } : {},
    )));
  }, [isPlatformAdmin, requestNavigation]);

  return { mode, target, activeSection, navigate, close, open, openOrganizationGovernance, guardNavigation: requestNavigation, onControllerChange };
}
