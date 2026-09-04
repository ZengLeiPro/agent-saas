import { isAssignedToOrgAgent, type OrgAgentStore } from '../data/orgAgents/index.js';
import type { PgAssignmentStore } from '../data/assignments/index.js';
import type { PgMembershipStore } from '../data/memberships/index.js';
import type { OrgAgentChannelBinding } from '../data/orgGroupAgents/index.js';
import type { UserStore } from '../data/users/store.js';
import type { ChannelContext, UserIdentity } from '../types/index.js';

export interface SharedGroupDwsLiveAuthorizerDeps {
  userStore: Pick<UserStore, 'findById'>;
  membershipStore?: Pick<PgMembershipStore, 'getMembership'>;
  assignmentStore?: Pick<PgAssignmentStore, 'listEffectiveResourceIds'>;
  orgAgentStore?: Pick<OrgAgentStore, 'get'>;
}

export async function authorizeSharedGroupDwsRequester(
  deps: SharedGroupDwsLiveAuthorizerDeps,
  input: {
    channel: NonNullable<ChannelContext['orgAgentChannel']>;
    binding: OrgAgentChannelBinding;
    requester: UserIdentity;
  },
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const actor = input.channel.externalActor;
  if (
    actor.kind !== 'external_user' ||
    actor.assurance !== 'mapped' ||
    !actor.mappedUserId ||
    actor.mappedUserId !== input.requester.id
  ) {
    return { allowed: false, reason: 'REQUESTER_IDENTITY_INVALID' };
  }
  if (!deps.membershipStore || !deps.assignmentStore || !deps.orgAgentStore) {
    return { allowed: false, reason: 'REQUESTER_AUTHORITY_UNAVAILABLE' };
  }
  if (
    input.binding.activationState !== 'active' ||
    !input.binding.enabled ||
    !input.binding.policy.enabled ||
    input.binding.policy.liveDeny ||
    input.binding.tenantId !== input.channel.agentPrincipal.tenantId ||
    input.binding.accountId !== input.channel.accountId ||
    input.binding.agentId !== input.channel.agentId ||
    input.binding.conversationId !== input.channel.channelPrincipal.conversationId ||
    input.binding.conversationSpaceId !== input.channel.conversationSpaceId ||
    input.binding.workspaceId !== input.channel.agentPrincipal.workspaceId ||
    input.binding.revision !== input.channel.policyRevision
  ) {
    return { allowed: false, reason: 'CHANNEL_BINDING_CHANGED' };
  }
  const currentUser = deps.userStore.findById(actor.mappedUserId);
  if (
    !currentUser ||
    currentUser.disabled ||
    currentUser.tenantId !== input.channel.agentPrincipal.tenantId ||
    currentUser.username !== input.requester.username
  ) {
    return { allowed: false, reason: 'REQUESTER_ACCOUNT_INACTIVE' };
  }
  const membership = await deps.membershipStore.getMembership(
    input.channel.agentPrincipal.tenantId,
    actor.mappedUserId,
  );
  if (
    !membership ||
    membership.status !== 'active' ||
    membership.persona !== actor.role ||
    membership.persona !== input.channel.actorRole ||
    (input.binding.effectiveConfig.access.triggerRoles.length > 0 &&
      !input.binding.effectiveConfig.access.triggerRoles.includes(membership.persona))
  ) {
    return { allowed: false, reason: 'REQUESTER_MEMBERSHIP_CHANGED' };
  }
  const agent = deps.orgAgentStore.get(input.channel.agentId);
  if (
    !agent ||
    !agent.enabled ||
    agent.tenantId !== input.channel.agentPrincipal.tenantId ||
    !isAssignedToOrgAgent(agent, currentUser.username)
  ) {
    return { allowed: false, reason: 'ORG_AGENT_AUDIENCE_CHANGED' };
  }
  const assignments = await deps.assignmentStore.listEffectiveResourceIds(
    input.channel.agentPrincipal.tenantId,
    actor.mappedUserId,
    'org_agent',
  );
  if (!assignments.some((item) => item.resourceId === input.channel.agentId)) {
    return { allowed: false, reason: 'ORG_AGENT_ASSIGNMENT_CHANGED' };
  }
  return { allowed: true };
}
