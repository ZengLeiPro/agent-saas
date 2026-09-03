import type { OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import type { AgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
import type { OrgAgentStore } from '../data/orgAgents/store.js';

export function createOrgAgentChannelPolicyEvaluator(
  store: OrgGroupAgentStore,
  accountStore: AgentDwsAccountStore,
  agentStore: OrgAgentStore,
) {
  return async (input: { tenantId: string; bindingId: string; accountId: string; agentId: string;
    conversationId: string; toolName: string }) => {
    const [binding, account] = await Promise.all([
      store.getBindingById(input.tenantId, input.bindingId),
      accountStore.getForTenant(input.tenantId, input.accountId),
    ]);
    if (!binding || !binding.enabled || !binding.policy.enabled || binding.policy.liveDeny) {
      return { allowed: false, reason: 'ChannelBinding disabled or live-denied' };
    }
    const agent = agentStore.get(input.agentId);
    if (binding.accountId !== input.accountId || binding.agentId !== input.agentId
      || binding.conversationId !== input.conversationId || !account || account.status !== 'active'
      || account.agentId !== input.agentId || !agent || !agent.enabled || agent.tenantId !== input.tenantId) {
      return { allowed: false, reason: 'ChannelBinding principal chain is stale or mismatched' };
    }
    return {
      allowed: binding.effectiveConfig.capabilities.toolNames.includes(input.toolName),
      reason: 'tool is outside current ChannelBinding capability',
    };
  };
}

export function createOrgAgentChannelPolicyRuntimeOptions(
  store: OrgGroupAgentStore | undefined,
  accountStore: AgentDwsAccountStore | undefined,
  agentStore: OrgAgentStore | undefined,
) {
  if (!store) return {};
  return {
    orgGroupAgentStore: store,
    ...(accountStore && agentStore ? {
      orgAgentChannelPolicyEvaluator: createOrgAgentChannelPolicyEvaluator(store, accountStore, agentStore),
    } : {}),
  };
}
