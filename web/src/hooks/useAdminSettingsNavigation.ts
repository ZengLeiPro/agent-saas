import { useCallback } from "react";

import {
  buildPlatformAdminUrl,
  buildTenantAdminUrl,
  buildUrl,
  closePersonalSettingsHistory,
  normalizeAdminSettingsSection,
  preserveSearchKeys,
  pushAdminSettingsUrl,
  readPersonalSettingsHistoryState,
  TENANT_ADMIN_SCOPE_KEYS,
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
    const tab = deps.getActiveTab();
    if (tab === "platform-admin") return buildPlatformAdminUrl(deps.getPlatformRoute());
    if (tab === "tenant-admin") {
      return buildTenantAdminUrl({ section: deps.getTenantSection(), search: preserveSearchKeys(TENANT_ADMIN_SCOPE_KEYS) });
    }
    return buildUrl(tab, tab === "chat" ? deps.getSessionId() : null);
  }, [deps]);

  const openAdminSettings = useCallback((target: AdminSettingsTarget, section?: string) => {
    const normalized = normalizeAdminSettingsSection(target, section);
    const history = readPersonalSettingsHistoryState();
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    const fromSettingsRoute = isUnifiedSettingsUrl(currentUrl);
    const source = history?.source ?? (fromSettingsRoute ? returnUrl() : currentUrl);
    if (!history && fromSettingsRoute) window.history.replaceState({}, "", source);
    deps.openState(target, normalized);
    pushAdminSettingsUrl(target, normalized, { source, depth: history ? history.depth + 1 : 1 });
  }, [deps, returnUrl]);

  const closeAdminSettings = useCallback(() => {
    if (!deps.getCurrentSettings()) return;
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
    if (!history && isUnifiedSettingsUrl(currentUrl)) window.history.replaceState({}, "", source);
    deps.openState(current.target, normalized);
    pushAdminSettingsUrl(current.target, normalized, {
      source,
      depth: history ? history.depth + 1 : 1,
    });
  }, [deps, returnUrl]);

  return { openAdminSettings, closeAdminSettings, setAdminSettingsSection };
}
