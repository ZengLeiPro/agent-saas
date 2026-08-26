import { useCallback, useEffect, useRef } from "react";

import type { ManagementSettingsAccess } from "@/hooks/useManagementSettingsAccess";
import { closeAnalysisHistory, ensureAnalysisHistoryEntry, markAnalysisHistoryEntry } from "@/lib/analysisHistory";
import { analysisNavigationRoute } from "@/lib/analysisNavigation";
export { isAnalysisRoute } from "@/lib/analysisNavigation";
import { parseGovernanceUrl, type GovernanceRouteState } from "@/lib/governanceNavigation";
import { buildUrl, navigateGovernance } from "@/lib/urlSync";
import type { AppTab } from "@/types/sidebar";

export function useUnifiedAnalysisWorkspace({
  mode,
  governanceRoute,
  managementAccess,
  sessionId,
  pushActiveTab,
  setActiveTab,
}: {
  mode: boolean;
  governanceRoute: GovernanceRouteState | null;
  managementAccess: ManagementSettingsAccess;
  sessionId: string | null;
  pushActiveTab: (tab: AppTab) => void;
  setActiveTab: (tab: AppTab) => void;
}) {
  const lastOrgIdRef = useRef<string | null>(null);
  if (governanceRoute?.area === "organization" && governanceRoute.orgId) lastOrgIdRef.current = governanceRoute.orgId;

  const open = useCallback(() => {
    const source = `${window.location.pathname}${window.location.search}`;
    pushActiveTab(managementAccess.platformEntryAllowed ? "platform-admin" : "tenant-admin");
    markAnalysisHistoryEntry(source, 1);
  }, [managementAccess.platformEntryAllowed, pushActiveTab]);
  const close = useCallback(() => closeAnalysisHistory(() => setActiveTab("chat")), [setActiveTab]);
  const navigate = useCallback((routeId: string) => {
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    const parsed = parseGovernanceUrl(currentUrl);
    const currentRoute = parsed.kind === "route" ? parsed.route : governanceRoute;
    const nextRoute = analysisNavigationRoute(routeId, currentRoute, lastOrgIdRef.current);
    if (nextRoute) navigateGovernance(nextRoute);
  }, [governanceRoute]);

  useEffect(() => {
    if (mode) ensureAnalysisHistoryEntry(buildUrl("chat", sessionId));
  }, [mode, sessionId]);

  return { open, close, navigate };
}
