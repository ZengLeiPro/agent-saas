import { useCallback, useRef, useState } from "react";

import { addSessionsToGroup } from "@/lib/groupsApi";

export function usePendingNewSessionTarget() {
  const pendingOrgAgentIdRef = useRef<string | null>(null);
  const pendingNewSessionGroupIdRef = useRef<string | null>(null);
  const [pendingOrgAgentId, setPendingOrgAgentId] = useState<string | null>(null);

  const clearPendingOrgAgent = useCallback(() => {
    pendingOrgAgentIdRef.current = null;
    setPendingOrgAgentId(null);
  }, []);

  const assignPendingGroup = useCallback((sessionId: string) => {
    const groupId = pendingNewSessionGroupIdRef.current;
    pendingNewSessionGroupIdRef.current = null;
    if (!groupId) return;
    void addSessionsToGroup(groupId, [sessionId])
      .then((updated) => {
        if (!updated) console.error("新会话加入分组失败");
      })
      .catch((error) => console.error("新会话加入分组失败", error));
  }, []);

  return {
    pendingOrgAgentIdRef,
    pendingNewSessionGroupIdRef,
    pendingOrgAgentId,
    setPendingOrgAgentId,
    clearPendingOrgAgent,
    assignPendingGroup,
  };
}
