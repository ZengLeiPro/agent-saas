import type { OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';

export function createOrgAgentChannelPolicyEvaluator(store: OrgGroupAgentStore) {
  return async (input: { tenantId: string; bindingId: string; toolName: string }) => {
    const binding = await store.getBindingById(input.tenantId, input.bindingId);
    if (!binding || !binding.enabled || !binding.policy.enabled || binding.policy.liveDeny) {
      return { allowed: false, reason: 'ChannelBinding disabled or live-denied' };
    }
    return {
      allowed: binding.effectiveConfig.capabilities.toolNames.includes(input.toolName),
      reason: 'tool is outside current ChannelBinding capability',
    };
  };
}
