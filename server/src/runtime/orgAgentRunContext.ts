import type { ChannelContext, UserIdentity } from '../types/index.js';
import { parseOrgAgentChannel } from './background/backgroundTaskMetadata.js';

type OrgAgentRunContextSnapshot = {
  orgAgentChannel: NonNullable<ChannelContext['orgAgentChannel']>;
  orgAgentRequester?: UserIdentity;
};

type OrgAgentRequesterAuthorizer = (input: {
  channel: NonNullable<ChannelContext['orgAgentChannel']>;
  requester: UserIdentity;
}) => Promise<{ allowed: boolean; reason?: string }>;

export function snapshotOrgAgentRunContext(
  context: ChannelContext,
): Partial<OrgAgentRunContextSnapshot> {
  if (!context.orgAgentChannel) return {};
  const actor = context.orgAgentChannel.externalActor;
  const requester = context.user;
  const validRequester =
    actor.kind === 'external_user' &&
    actor.assurance === 'mapped' &&
    Boolean(requester) &&
    requester!.id === actor.mappedUserId &&
    requester!.tenantId === context.orgAgentChannel.agentPrincipal.tenantId;
  return {
    orgAgentChannel: context.orgAgentChannel,
    ...(validRequester ? { orgAgentRequester: requester } : {}),
  };
}

export function restoreOrgAgentRunContext(
  metadata: Record<string, unknown>,
): Pick<ChannelContext, 'orgAgentChannel' | 'user'> {
  const orgAgentChannel = parseOrgAgentChannel(metadata.orgAgentChannel);
  if (!orgAgentChannel) return {};
  const actor = orgAgentChannel.externalActor;
  const requester = parseRequester(metadata.orgAgentRequester);
  const validRequester =
    actor.kind === 'external_user' &&
    actor.assurance === 'mapped' &&
    Boolean(requester) &&
    requester!.id === actor.mappedUserId &&
    requester!.tenantId === orgAgentChannel.agentPrincipal.tenantId;
  return {
    orgAgentChannel,
    ...(validRequester ? { user: requester } : {}),
  };
}

export async function authorizeRestoredOrgAgentRequester(
  metadata: Record<string, unknown>,
  authorizer?: OrgAgentRequesterAuthorizer,
): Promise<{ allowed: boolean; reason?: string }> {
  const context = restoreOrgAgentRunContext(metadata);
  if (!context.orgAgentChannel) return { allowed: true };
  const actor = context.orgAgentChannel.externalActor;
  if (
    actor.kind !== 'external_user' ||
    actor.assurance !== 'mapped' ||
    !context.user ||
    !authorizer
  ) {
    return { allowed: false, reason: 'ORG_AGENT_REQUESTER_AUTHORITY_UNAVAILABLE' };
  }
  try {
    return await authorizer({ channel: context.orgAgentChannel, requester: context.user });
  } catch {
    return { allowed: false, reason: 'ORG_AGENT_REQUESTER_AUTHORITY_FAILED' };
  }
}

function parseRequester(value: unknown): UserIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== 'string' ||
    !raw.id ||
    typeof raw.username !== 'string' ||
    !raw.username ||
    (raw.role !== 'admin' && raw.role !== 'user') ||
    typeof raw.tenantId !== 'string' ||
    !raw.tenantId
  )
    return undefined;
  return {
    id: raw.id,
    username: raw.username,
    role: raw.role,
    tenantId: raw.tenantId,
    ...(typeof raw.realName === 'string' ? { realName: raw.realName } : {}),
    ...(typeof raw.externalId === 'string' ? { externalId: raw.externalId } : {}),
    ...(typeof raw.dingtalkStaffId === 'string' ? { dingtalkStaffId: raw.dingtalkStaffId } : {}),
  };
}
