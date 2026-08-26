import type { GovernanceArea } from "@/lib/governanceNavigation";
import type { AdminSettingsTarget } from "@/lib/urlSync";
import type { AppTab } from "@/types/sidebar";

export type ManagementAccessTarget = "personal" | AdminSettingsTarget;

export function legacyRoleFallbackTab({
  activeTab,
  personalAgentEnabled,
  isAdmin,
  isPlatformAdmin,
}: {
  activeTab: AppTab;
  personalAgentEnabled: boolean;
  isAdmin: boolean;
  isPlatformAdmin: boolean;
}): AppTab | null {
  if (!personalAgentEnabled && (activeTab === "scenarios" || activeTab === "profile" || activeTab === "cron")) {
    return "capabilities";
  }
  if (!isAdmin && (activeTab === "skills" || activeTab === "usage")) return "chat";
  if (!isPlatformAdmin && (activeTab === "tenants" || activeTab === "models")) return "chat";
  return null;
}

export function managementAccessTarget({
  settingsOpen,
  adminSettingsTarget,
  activeTab,
  governanceArea,
}: {
  settingsOpen: boolean;
  adminSettingsTarget: AdminSettingsTarget | null | undefined;
  activeTab: AppTab;
  governanceArea: GovernanceArea | null | undefined;
}): ManagementAccessTarget | null {
  if (settingsOpen) return "personal";
  if (adminSettingsTarget) return adminSettingsTarget;
  if (activeTab === "tenant-admin" && (!governanceArea || governanceArea === "organization")) return "tenant";
  if (activeTab === "platform-admin" && (!governanceArea || governanceArea === "platform")) return "platform";
  return null;
}
