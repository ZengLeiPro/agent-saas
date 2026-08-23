import type { OrgAgentRecord } from '../data/orgAgents/types.js';
import type { RawRuntimeRunDispatchConfig } from './rawRuntimeRunDispatchTypes.js';
import {
  createOrgAgentSessionSnapshot,
  type OrgAgentCollectionAssignmentPin,
  type RuntimeSessionRecord,
} from './sessionCatalog.js';

/** Resolve org Agent selection without ever falling back to a personal Agent on denial. */
export function resolveOrgAgentOverrides(
  config: Pick<RawRuntimeRunDispatchConfig, 'orgAgentStore'>,
  orgAgentId: string | undefined,
  tenantId: string | undefined,
): null | { error: string } | { agent: OrgAgentRecord } {
  if (!orgAgentId) return null;
  const store = config.orgAgentStore;
  if (!store) {
    return { error: `企业专家服务不可用（orgAgentId=${orgAgentId}），已终止本次运行` };
  }
  const record = store.get(orgAgentId);
  if (!record || !record.enabled || !record.audience) {
    return { error: '该企业专家已被停用或删除，请联系组织管理员' };
  }
  if (record.tenantId !== tenantId) {
    return { error: '该企业专家已被停用或删除，请联系组织管理员' };
  }
  return { agent: record };
}

/** Pin collection authorization once for a new org-Agent session and inherit it on resume/replay. */
export async function resolveOrgAgentSessionSnapshot(input: {
  orgAgent: OrgAgentRecord | undefined;
  existingSession?: RuntimeSessionRecord | null;
  replaySourceSession?: RuntimeSessionRecord | null;
  tenantId?: string;
  userId?: string;
  agentId?: string;
  resolveAssignments?: (scope: {
    tenantId: string;
    userId: string;
    agentId: string;
  }) => Promise<OrgAgentCollectionAssignmentPin[]>;
}): Promise<RuntimeSessionRecord['orgAgentSnapshot'] | undefined> {
  const inherited = input.existingSession?.orgAgentSnapshot
    ?? input.replaySourceSession?.orgAgentSnapshot;
  if (inherited || input.existingSession || !input.orgAgent) return inherited;
  const assignments = input.agentId && input.userId && input.tenantId && input.resolveAssignments
    ? await input.resolveAssignments({
        tenantId: input.tenantId,
        userId: input.userId,
        agentId: input.agentId,
      })
    : undefined;
  return createOrgAgentSessionSnapshot(input.orgAgent, assignments);
}
