import type { ChannelContext, UserIdentity } from '../types/index.js';

/** Shared channels execute as the Agent principal, never as the human who mentioned it. */
export function resolveWorkspacePrincipal(context: ChannelContext): {
  identity?: UserIdentity;
  tenantId?: string;
} {
  const identity = context.orgAgentChannel
    ? context.sessionOwner
    : (context.user ?? context.sessionOwner);
  const tenantId = context.orgAgentChannel
    ? context.sessionOwner?.tenantId
    : (context.user?.tenantId ?? context.sessionOwner?.tenantId);
  return { identity, tenantId };
}
