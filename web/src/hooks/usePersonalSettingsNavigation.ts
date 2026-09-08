import { useCallback } from "react";

import type { GovernanceRouteState } from "@/lib/governanceNavigation";
import { replaceAppHistoryState } from "@/lib/appHistory";
import {
  buildUrl,
  closePersonalSettingsHistory,
  governanceSettingsRoute,
  pushSettingsRoute,
  readPersonalSettingsHistoryState,
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
    const activeTab = deps.getActiveTab();
    // 直接打开管理设置时没有来源记录；回退到主内容，不能再次打开管理工作区。
    const tab = activeTab === 'platform-admin' || activeTab === 'tenant-admin' ? 'chat' : activeTab;
    return buildUrl(tab, tab === 'chat' ? deps.getSessionId() : null);
  }, [deps]);

  const openSettings = useCallback((section: SettingsSectionId = "account-security") => {
    const normalized = normalizeSettingsSection(section);
    const route = governanceSettingsRoute(section);
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    const current = readPersonalSettingsHistoryState();
    const fromSettingsRoute = isUnifiedSettingsUrl(currentUrl);
    const source = current?.source ?? (fromSettingsRoute ? returnUrl() : currentUrl);
    if (!current && fromSettingsRoute) replaceAppHistoryState({}, source);
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
    if (!current && isUnifiedSettingsUrl(currentUrl)) replaceAppHistoryState({}, source);
    deps.openState(normalized, route);
    pushSettingsRoute(route, { source, depth: current ? current.depth + 1 : 1 });
  }, [deps, returnUrl]);

  return { openSettings, closeSettings, setSettingsSection };
}
