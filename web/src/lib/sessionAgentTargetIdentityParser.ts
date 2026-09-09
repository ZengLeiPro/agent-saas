import { parseAgentTarget, type AgentTargetIdentitySnapshot, type AgentTargetUnavailableReason } from '@agent/shared';
import type { SessionAgentTargetFields } from './sessionAgentTargetIdentity';

const SERVER_REASON_CODES = new Set([
  'personal_agent_disabled', 'org_agent_unassigned', 'org_agent_disabled', 'org_agent_deleted',
  'tenant_mismatch', 'legacy_binding_unproven', 'no_available_target', 'target_catalog_unavailable',
]);
const SNAPSHOT_STATUSES = new Set(['available', 'disabled', 'revoked', 'deleted', 'unproven']);

/** Read only the identity slice from an authenticated, session-scoped detail response. */
export function parseSessionAgentTargetIdentity(
  value: unknown,
  sessionId: string,
  tenantId?: string,
): SessionAgentTargetFields | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.sessionId !== sessionId) return null;
  const target = parseAgentTarget(record.agentTarget);
  if (record.agentTarget !== undefined && !target) return null;
  if (target && tenantId && target.tenantId !== tenantId) return null;

  let reason: AgentTargetUnavailableReason | undefined;
  if (record.agentTargetUnavailableReason !== undefined) {
    const candidate = record.agentTargetUnavailableReason;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const r = candidate as Record<string, unknown>;
    if (typeof r.code !== 'string' || !SERVER_REASON_CODES.has(r.code)
      || typeof r.message !== 'string' || !r.message.trim() || typeof r.contactAdmin !== 'boolean') return null;
    reason = r as unknown as AgentTargetUnavailableReason;
  }
  // Only an explicit server refusal can classify a target-less session as unproven.
  if (!target) return reason ? { agentTargetUnavailableReason: reason } : null;

  const candidate = record.agentTargetSnapshot;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const snapshot = candidate as Record<string, unknown>;
  if (typeof snapshot.name !== 'string' || !snapshot.name.trim()
    || typeof snapshot.status !== 'string' || !SNAPSHOT_STATUSES.has(snapshot.status)
    || typeof snapshot.version !== 'number' || !Number.isFinite(snapshot.version) || snapshot.version < 1
    || typeof record.agentTargetBindingVersion !== 'number'
    || !Number.isInteger(record.agentTargetBindingVersion) || record.agentTargetBindingVersion < 1) return null;
  // An unavailable snapshot cannot silently reopen sending if its reason was lost in transit.
  if (snapshot.status !== 'available' && !reason && snapshot.status !== 'unproven') return null;

  const identitySnapshot = snapshot as unknown as AgentTargetIdentitySnapshot;
  return {
    agentTarget: target,
    agentTargetBindingVersion: record.agentTargetBindingVersion,
    agentTargetSnapshot: identitySnapshot,
    agentTargetUnavailableReason: reason,
    ...(target.kind === 'org-agent' ? {
      orgAgentId: target.orgAgentId,
      orgAgentName: identitySnapshot.name,
      orgAgentAvailable: !reason && snapshot.status === 'available',
    } : {}),
  };
}
