import type { RuntimeSessionRecord } from './sessionCatalog.js';
import { deriveAgentWorkspaceId, deriveStableWorkspaceId } from './workspaceIdentity.js';

export function deriveRuntimeWorkspaceId(params: {
  existingSession?: RuntimeSessionRecord | null;
  fallbackSessionId: string;
  identity?: { id?: string; tenantId?: string };
  orgAgentId?: string;
}): string {
  return (
    params.existingSession?.workspaceId ??
    (params.orgAgentId && params.identity?.tenantId
      ? deriveAgentWorkspaceId(params.identity.tenantId, params.orgAgentId)
      : undefined) ??
    deriveStableWorkspaceId(params.identity, params.fallbackSessionId)
  );
}

export function requestedSessionPrincipal(input: {
  agentPrincipal?: Extract<NonNullable<RuntimeSessionRecord['principal']>, { kind: 'org_agent' }>;
  userId?: string;
}): RuntimeSessionRecord['principal'] {
  return (
    input.agentPrincipal ?? (input.userId ? { kind: 'user', userId: input.userId } : undefined)
  );
}

export function runtimePrincipalMatches(
  pinned: RuntimeSessionRecord['principal'],
  requested: RuntimeSessionRecord['principal'],
  legacy?: Pick<RuntimeSessionRecord, 'userId' | 'tenantId' | 'orgAgentId' | 'workspaceId'>,
): boolean {
  if (pinned && requested) return JSON.stringify(pinned) === JSON.stringify(requested);
  if (pinned || !requested) return !pinned && !requested;
  if (!legacy) return false;
  if (requested.kind === 'user') return legacy.userId === requested.userId;
  return legacy.tenantId === requested.tenantId
    && legacy.orgAgentId === requested.agentId
    && legacy.workspaceId === requested.workspaceId;
}
