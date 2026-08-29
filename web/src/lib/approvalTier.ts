import type { UserPreferences } from "@agent/shared";

export type ApprovalTier = "ask" | "low-risk" | "full";

export type ApprovalPolicyPayload =
  | { autoApproveTools: true; lowRiskOnly?: true }
  | { autoApproveTools: false };

/**
 * 账户级三档「有效批准策略」。与服务端 userPreferenceResolvers.ts 的
 * resolveUserAutoApproveTools / resolveUserLowRiskAutoApprove 保持同一语义：
 * authorizationModeEnabled 缺失时默认开启全部授权（?? true，老用户默认值），
 * 低风险档仅在全部授权关闭时生效。Web 端所有消费点（聊天 hook、Desktop/Mobile
 * 布局、个人设置）必须经由此函数取值，避免「设置显示每次询问、运行时却自动放行」
 * 的状态漂移（TASK-256）。
 */
export function resolveApprovalTier(preferences?: UserPreferences | null): ApprovalTier {
  if (preferences?.authorizationModeEnabled === false) {
    return preferences.lowRiskToolsAutoApproveEnabled === true ? "low-risk" : "ask";
  }
  return "full";
}

/**
 * 三档对应的 approvalPolicy WS payload。ask 档返回关闭指令（autoApproveTools:false），
 * 用于把活跃 run 重置回人工审批；低风险档带 lowRiskOnly，dangerous 仍人工。
 */
export function approvalPolicyPayloadForTier(tier: ApprovalTier): ApprovalPolicyPayload {
  if (tier === "full") return { autoApproveTools: true };
  if (tier === "low-risk") return { autoApproveTools: true, lowRiskOnly: true };
  return { autoApproveTools: false };
}
