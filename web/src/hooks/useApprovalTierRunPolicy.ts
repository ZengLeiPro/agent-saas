import { useCallback, useEffect } from "react";

import { approvalPolicyPayloadForTier, type ApprovalTier } from "@/lib/approvalTier";
import { clearRunShellApprovalStorage, runShellApprovalStorageKey } from "@/lib/runShellApprovalStorage";
import { wsClient } from "@/lib/wsClient";
import { isActiveRuntimeStatus } from "./chatRuntimeHelpers";
import type { SessionRuntime } from "./useChatAppStateTypes";

/**
 * TASK-256：三档「有效批准策略」向活跃 run 的传播逻辑（自 useChatAppState 抽出）。
 * 档位变化（含 ask->low-risk、full->low-risk）都会触发：
 * full/low-risk 向活跃 run 发送对应策略（低风险档带 lowRiskOnly），
 * ask 发送关闭指令重置回人工审批；低风险档即使会话开关被拨动也维持 lowRiskOnly，
 * 不升为全量自动批准。
 */
export function useApprovalTierRunPolicy(options: {
  approvalTier: ApprovalTier;
  sessionIdRef: { current: string | null };
  activeRunsBySession: { current: Map<string, SessionRuntime> };
  setAutoApproveRunShellState: (value: boolean) => void;
}) {
  const { approvalTier, sessionIdRef, activeRunsBySession, setAutoApproveRunShellState } = options;

  const setAutoApproveRunShell = useCallback((checked: boolean) => {
    // full / low-risk 档强制开启显示态；ask 档使用会话级开关值。
    const nextChecked = approvalTier !== "ask" ? true : checked;
    setAutoApproveRunShellState(nextChecked);
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) return;
    if (approvalTier === "ask") {
      localStorage.setItem(runShellApprovalStorageKey(currentSessionId), nextChecked ? 'true' : 'false');
    }
    const activeRun = activeRunsBySession.current.get(currentSessionId);
    if (activeRun?.runId && isActiveRuntimeStatus(activeRun.status)) {
      void wsClient.ensureConnectedSend({
        action: 'approval_policy',
        sessionId: currentSessionId,
        runId: activeRun.runId,
        approvalPolicy: approvalTier === "low-risk"
          ? approvalPolicyPayloadForTier("low-risk")
          : { autoApproveTools: nextChecked },
      });
    }
  }, [approvalTier, activeRunsBySession, sessionIdRef, setAutoApproveRunShellState]);

  useEffect(() => {
    const currentSessionId = sessionIdRef.current;
    const activeRun = currentSessionId ? activeRunsBySession.current.get(currentSessionId) : undefined;
    const sendCurrentRunPolicy = (approvalPolicy: { autoApproveTools: boolean; lowRiskOnly?: boolean }) => {
      if (!currentSessionId || !activeRun?.runId || !isActiveRuntimeStatus(activeRun.status)) return;
      void wsClient.ensureConnectedSend({
        action: 'approval_policy',
        sessionId: currentSessionId,
        runId: activeRun.runId,
        approvalPolicy,
      });
    };

    if (approvalTier === "full" || approvalTier === "low-risk") {
      setAutoApproveRunShellState(true);
      sendCurrentRunPolicy(approvalPolicyPayloadForTier(approvalTier));
      return;
    }

    setAutoApproveRunShellState(false);
    clearRunShellApprovalStorage();
    sendCurrentRunPolicy({ autoApproveTools: false });
  }, [approvalTier, activeRunsBySession, sessionIdRef, setAutoApproveRunShellState]);

  return { setAutoApproveRunShell };
}
