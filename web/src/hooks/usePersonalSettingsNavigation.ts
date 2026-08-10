import { useCallback } from "react";

import type { GovernanceRouteState } from "@/lib/governanceNavigation";
import {
  buildPlatformAdminUrl,
  buildTenantAdminUrl,
  buildUrl,
  closePersonalSettingsHistory,
  governanceSettingsRoute,
  preserveSearchKeys,
  pushSettingsRoute,
  readPersonalSettingsHistoryState,
  TENANT_ADMIN_SCOPE_KEYS,
  normalizeSettingsSection,
  type PlatformAdminSection,
  type TenantAdminSection,
} from "@/lib/urlSync";
import type { AppTab } from "@/types/sidebar";
import type { CanonicalSettingsSectionId, SettingsSectionId } from "@/types/settings";

export interface PersonalSettingsNavigationDeps {
  getActiveTab: () => AppTab;
  getPlatformRoute: () => { section?: PlatformAdminSection | null; entityId?: string | null };
  getTenantSection: () => TenantAdminSection;
  getSessionId: () => string | null;
  openState: (section: CanonicalSettingsSectionId, route: GovernanceRouteState) => void;
  closeState: () => void;
}

export function usePersonalSettingsNavigation(deps: PersonalSettingsNavigationDeps) {
  const returnUrl = useCallback(() => {
    const tab = deps.getActiveTab();
    if (tab === "platform-admin") return buildPlatformAdminUrl(deps.getPlatformRoute());
    if (tab === "tenant-admin") {
      return buildTenantAdminUrl({ section: deps.getTenantSection(), search: preserveSearchKeys(TENANT_ADMIN_SCOPE_KEYS) });
    }
    return buildUrl(tab, tab === "chat" ? deps.getSessionId() : null);
  }, [deps]);

  const openSettings = useCallback((section: SettingsSectionId = "account-security") => {
    const normalized = normalizeSettingsSection(section);
    const route = governanceSettingsRoute(section);
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    const source = currentUrl.startsWith("/settings") ? returnUrl() : currentUrl;
    deps.openState(normalized, route);
    pushSettingsRoute(route, { source, depth: 1 });
  }, [deps, returnUrl]);

  const closeSettings = useCallback(() => {
    deps.closeState();
    closePersonalSettingsHistory(returnUrl());
  }, [deps, returnUrl]);

  const setSettingsSection = useCallback((section: SettingsSectionId) => {
    const normalized = normalizeSettingsSection(section);
    const route = governanceSettingsRoute(section);
    const current = readPersonalSettingsHistoryState();
    deps.openState(normalized, route);
    pushSettingsRoute(route, current
      ? { source: current.source, depth: current.depth + 1 }
      : { source: returnUrl(), depth: 1 });
  }, [deps, returnUrl]);

  return { openSettings, closeSettings, setSettingsSection };
}
