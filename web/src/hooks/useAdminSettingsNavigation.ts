import { useCallback } from "react";

import { replaceAppHistoryState } from "@/lib/appHistory";
import {
  buildUrl,
  closePersonalSettingsHistory,
  normalizeAdminSettingsSection,
  pushAdminSettingsUrl,
  readPersonalSettingsHistoryState,
  type AdminSettingsState,
  type AdminSettingsTarget,
  type PlatformAdminSection,
  type TenantAdminSection,
} from "@/lib/urlSync";
import type { AppTab } from "@/types/sidebar";

export interface AdminSettingsNavigationDeps {
  getActiveTab: () => AppTab;
  getPlatformRoute: () => { section?: PlatformAdminSection | null; entityId?: string | null };
  getTenantSection: () => TenantAdminSection;
  getSessionId: () => string | null;
  getCurrentSettings: () => AdminSettingsState | null;
  openState: (target: AdminSettingsTarget, section: string) => void;
  closeState: () => void;
}

function isUnifiedSettingsUrl(url: string): boolean {
  return url.startsWith("/settings")
    || url.startsWith("/tenant-admin/settings")
    || url.startsWith("/platform-admin/settings");
}

export function useAdminSettingsNavigation(deps: AdminSettingsNavigationDeps) {
  const returnUrl = useCallback(() => {
    const activeTab = deps.getActiveTab();
    // 直接打开管理设置时没有来源记录；回退到主内容，不能再次打开管理工作区。
    const tab = activeTab === 'platform-admin' || activeTab === 'tenant-admin' ? 'chat' : activeTab;
    return buildUrl(tab, tab === 'chat' ? deps.getSessionId() : null);
  }, [deps]);

  const openAdminSettings = useCallback((target: AdminSettingsTarget, section?: string) => {
    const normalized = normalizeAdminSettingsSection(target, section);
    const history = readPersonalSettingsHistoryState();
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    const fromSettingsRoute = isUnifiedSettingsUrl(currentUrl);
    const source = history?.source ?? (fromSettingsRoute ? returnUrl() : currentUrl);
    if (!history && fromSettingsRoute) replaceAppHistoryState({}, source);
    deps.openState(target, normalized);
    pushAdminSettingsUrl(target, normalized, { source, depth: history ? history.depth + 1 : 1 });
  }, [deps, returnUrl]);

  const closeAdminSettings = useCallback(() => {
    deps.closeState();
    closePersonalSettingsHistory(returnUrl());
  }, [deps, returnUrl]);

  const setAdminSettingsSection = useCallback((section: string) => {
    const current = deps.getCurrentSettings();
    if (!current) return;
    const normalized = normalizeAdminSettingsSection(current.target, section);
    const history = readPersonalSettingsHistoryState();
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    const source = history?.source ?? returnUrl();
    if (!history && isUnifiedSettingsUrl(currentUrl)) replaceAppHistoryState({}, source);
    deps.openState(current.target, normalized);
    pushAdminSettingsUrl(current.target, normalized, {
      source,
      depth: history ? history.depth + 1 : 1,
    });
  }, [deps, returnUrl]);

  return { openAdminSettings, closeAdminSettings, setAdminSettingsSection };
}
