import { useCallback, useRef, useState } from "react";

import type { AgentTarget } from "@agent/shared";
import { addSessionsToGroup } from "@/lib/groupsApi";

const GROUP_ASSIGNMENT_RETRY_DELAYS_MS = [100, 300];

export function usePendingNewSessionTarget() {
  const pendingAgentTargetRef = useRef<AgentTarget | null>(null);
  const pendingNewSessionGroupIdRef = useRef<string | null>(null);
  const groupAssignmentRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const [pendingAgentTarget, setPendingAgentTargetState] = useState<AgentTarget | null>(null);

  const setPendingAgentTarget = useCallback((target: AgentTarget | null) => {
    pendingAgentTargetRef.current = target;
    setPendingAgentTargetState(target);
  }, []);

  const clearPendingOrgAgent = useCallback(() => {
    setPendingAgentTarget(null);
  }, [setPendingAgentTarget]);

  const assignPendingGroup = useCallback((sessionId: string): Promise<void> => {
    const groupId = pendingNewSessionGroupIdRef.current;
    if (!groupId) return Promise.resolve();

    const key = `${groupId}:${sessionId}`;
    if (groupAssignmentRef.current?.key === key) return groupAssignmentRef.current.promise;

    const promise = (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= GROUP_ASSIGNMENT_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          const updated = await addSessionsToGroup(groupId, [sessionId]);
          if (!updated) throw new Error("分组接口未返回更新结果");
          if (pendingNewSessionGroupIdRef.current === groupId) {
            pendingNewSessionGroupIdRef.current = null;
          }
          return;
        } catch (error) {
          lastError = error;
          const retryDelay = GROUP_ASSIGNMENT_RETRY_DELAYS_MS[attempt];
          if (retryDelay === undefined) break;
          await new Promise((resolve) => window.setTimeout(resolve, retryDelay));
        }
      }
      console.error("新会话加入分组失败，保留待重试目标", lastError);
    })().finally(() => {
      if (groupAssignmentRef.current?.key === key) groupAssignmentRef.current = null;
    });

    groupAssignmentRef.current = { key, promise };
    return promise;
  }, []);

  return {
    pendingAgentTargetRef,
    pendingNewSessionGroupIdRef,
    pendingAgentTarget,
    pendingOrgAgentId: pendingAgentTarget?.kind === 'org-agent' ? pendingAgentTarget.orgAgentId : null,
    setPendingAgentTarget,
    clearPendingOrgAgent,
    assignPendingGroup,
  };
}
