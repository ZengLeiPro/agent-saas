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

function isUnifiedSettingsUrl(url: string): boolean {
  return url.startsWith("/settings")
    || url.startsWith("/tenant-admin/settings")
    || url.startsWith("/platform-admin/settings");
}

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
    const current = readPersonalSettingsHistoryState();
    const fromSettingsRoute = isUnifiedSettingsUrl(currentUrl);
    const source = current?.source ?? (fromSettingsRoute ? returnUrl() : currentUrl);
    if (!current && fromSettingsRoute) window.history.replaceState({}, "", source);
    deps.openState(normalized, route);
    pushSettingsRoute(route, { source, depth: current ? current.depth + 1 : 1 });
  }, [deps, returnUrl]);

  const closeSettings = useCallback(() => {
    deps.closeState();
    closePersonalSettingsHistory(returnUrl());
  }, [deps, returnUrl]);

  const setSettingsSection = useCallback((section: SettingsSectionId) => {
    const normalized = normalizeSettingsSection(section);
    const route = governanceSettingsRoute(section);
    const current = readPersonalSettingsHistoryState();
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    const source = current?.source ?? (isUnifiedSettingsUrl(currentUrl) ? returnUrl() : currentUrl);
    if (!current && isUnifiedSettingsUrl(currentUrl)) window.history.replaceState({}, "", source);
    deps.openState(normalized, route);
    pushSettingsRoute(route, { source, depth: current ? current.depth + 1 : 1 });
  }, [deps, returnUrl]);

  return { openSettings, closeSettings, setSettingsSection };
}
