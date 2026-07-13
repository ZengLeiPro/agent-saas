export type NewSessionTarget =
  | { kind: "personal" }
  | { kind: "org-agent"; agentId: string }
  | { kind: "picker" }
  | { kind: "unavailable" };

interface ResolveNewSessionTargetInput {
  activeOrgAgentId?: string | null;
  availableOrgAgentIds: string[];
  personalAgentEnabled: boolean;
}

/** 全局“新建会话”的唯一决策表，避免各入口各自猜测当前 Agent 上下文。 */
export function resolveNewSessionTarget({
  activeOrgAgentId,
  availableOrgAgentIds,
  personalAgentEnabled,
}: ResolveNewSessionTargetInput): NewSessionTarget {
  const uniqueAgentIds = [...new Set(availableOrgAgentIds.filter(Boolean))];
  if (activeOrgAgentId && uniqueAgentIds.includes(activeOrgAgentId)) {
    return { kind: "org-agent", agentId: activeOrgAgentId };
  }
  if (personalAgentEnabled) return { kind: "personal" };
  if (uniqueAgentIds.length === 1) {
    return { kind: "org-agent", agentId: uniqueAgentIds[0] };
  }
  if (uniqueAgentIds.length > 1) return { kind: "picker" };
  return { kind: "unavailable" };
}

/** 异步创建返回时再次核对账号，旧账号响应不得写入当前账号状态。 */
export function isCurrentAuthOwner(requestOwnerKey: string, currentOwnerKey: string): boolean {
  return requestOwnerKey === currentOwnerKey;
}
