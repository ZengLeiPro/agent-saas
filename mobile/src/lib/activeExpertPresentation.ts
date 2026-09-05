/**
 * 当前会话绑定的企业专家展示信息。
 *
 * 只从服务端下发的目录（`GET /api/org-agents/mine`）里按 `orgAgentId` 精确取，
 * 取不到就返回 null（空态回落到场景推荐卡），不在客户端拼装专家名或起手任务。
 */
import type { AgentTarget, AgentTargetCatalog, OrgAgentSummary } from '@agent/shared';

export function resolveActiveExpertPresentation(
  catalog: AgentTargetCatalog<OrgAgentSummary> | null | undefined,
  target: AgentTarget | null | undefined,
): OrgAgentSummary | null {
  if (!catalog || !target || target.kind !== 'org-agent') return null;
  const option = catalog.orgAgents.find(
    (candidate) =>
      candidate.target.kind === 'org-agent' && candidate.target.orgAgentId === target.orgAgentId,
  );
  return option?.presentation ?? null;
}
