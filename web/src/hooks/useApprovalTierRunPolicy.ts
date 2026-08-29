import { useCallback, useEffect } from "react";

import { approvalPolicyPayloadForTier, type ApprovalTier } from "@/lib/approvalTier";
import { clearRunShellApprovalStorage, runShellApprovalStorageKey } from "@/lib/runShellApprovalStorage";
import { wsClient } from "@/lib/wsClient";
import { isActiveRuntimeStatus } from "./chatRuntimeHelpers";
import type { SessionRuntime } from "./useChatAppStateTypes";

/**
 * TASK-256：三档「有效批准策略」向活跃 run 的传播逻辑（自 useChatAppState 抽出）。
 *
 * 权威链路（三轮 review 返工）：账户档位保存走 PATCH /me/preferences，服务端
 * convergeActiveRunApprovalPolicies 会原子重写该用户**所有**活跃 run 的 approvalPolicy
 * metadata（含其他会话与钉钉/定时任务渠道），下一次工具裁决从 runStore 读新策略。
 * 因此账户档位 effect 不再发送 best-effort WS（避免 ensureConnectedSend=false / 服务端拒绝
 * 却仍显示「已保存即生效」）；HTTP 保存只有在服务端收敛成功后才返回成功。
 *
 * ask 档的会话级「自动授权工具」开关（setAutoApproveRunShell）仍是 run 级升档：
 * 仅该开关开启时为该 run 发送全量自动批准，持久化在 localStorage，随会话切换恢复。
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
        // 低风险档即使会话开关被拨动，也维持 lowRiskOnly 语义，不升为全量自动批准。
        approvalPolicy: approvalTier === "low-risk"
          ? approvalPolicyPayloadForTier("low-risk")
          : { autoApproveTools: nextChecked },
      });
    }
  }, [approvalTier, activeRunsBySession, sessionIdRef, setAutoApproveRunShellState]);

  useEffect(() => {
    // 账户档位只同步本地展示态；所有 active run 的权威策略由保存偏好的 HTTP 服务端原子
    // 收敛。这里不再发当前会话 WS，避免 best-effort 失败却显示「已保存即生效」。
    if (approvalTier === "full" || approvalTier === "low-risk") {
      setAutoApproveRunShellState(true);
      return;
    }
    setAutoApproveRunShellState(false);
    clearRunShellApprovalStorage();
  }, [approvalTier, setAutoApproveRunShellState]);

  return { setAutoApproveRunShell };
}
