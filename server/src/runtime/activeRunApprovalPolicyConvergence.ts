import type { UserPreferences } from '../data/users/types.js';
import type { RunStore } from './runStoreTypes.js';

/** 账户级批准策略 metadata 值：null 表示运行中关闭授权（每次询问）。 */
export type AccountApprovalPolicyMetadata = { autoApproveTools: true; lowRiskOnly?: true } | null;

/**
 * TASK-256（三轮 review 返工）：从账户偏好解析应写入活跃 run 的 approvalPolicy metadata。
 * 与 rawAgentLoop.refreshApprovalPolicy / resolveEffectiveApprovalPolicy 同语义：
 * authorizationModeEnabled 缺省默认全部授权（?? true）；低风险档仅在全部授权关闭时生效。
 */
export function accountApprovalPolicyMetadata(
  preferences: UserPreferences | undefined,
): AccountApprovalPolicyMetadata {
  if (preferences?.authorizationModeEnabled ?? true) return { autoApproveTools: true };
  return preferences?.lowRiskToolsAutoApproveEnabled === true
    ? { autoApproveTools: true, lowRiskOnly: true }
    : null;
}

export interface ActiveRunPolicyConvergenceResult {
  /** 本次重写了 approvalPolicy metadata 的活跃 run。 */
  updatedRunIds: string[];
}

/**
 * TASK-256（三轮 review 返工）：账户级批准档位变化的服务端权威收敛。
 *
 * 此前账户降档只靠 Web 端 useApprovalTierRunPolicy 对「当前会话」best-effort 发 WS
 * approval_policy；其他会话/渠道（含钉钉、定时任务）的活跃 run metadata 仍保留旧
 * full 策略，rawAgentLoop.refreshApprovalPolicy 优先信任 metadata，导致后台 run 在
 * full->ask / full->low-risk 之后继续自动放行 dangerous（未标 neverAutoApprove）工具。
 *
 * 现在个人偏好保存链路（PATCH /api/auth/me/preferences）在档位字段变化后调用本函数，
 * 对该用户所有仍活跃的 run 重写 metadata.approvalPolicy（与 WS handleApprovalPolicy
 * 写入的形态一致），下一次工具裁决即读到新策略。runStore 不支持 listActiveByUser 或
 * 无活跃 run 时是安全的 no-op（新 dispatch 走 resolveEffectiveApprovalPolicy 现算）。
 */
export async function convergeActiveRunApprovalPolicies(
  runStore: Pick<RunStore, 'updateApprovalPolicyForActiveByUser'> | undefined,
  userId: string,
  preferences: UserPreferences | undefined,
): Promise<ActiveRunPolicyConvergenceResult> {
  if (!runStore?.updateApprovalPolicyForActiveByUser) return { updatedRunIds: [] };
  const updatedRunIds = await runStore.updateApprovalPolicyForActiveByUser(
    userId,
    accountApprovalPolicyMetadata(preferences),
  );
  return { updatedRunIds };
}
