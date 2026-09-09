import {
  parseAgentTarget,
  sameAgentTarget,
  type AgentTargetIdentitySnapshot,
  type AgentTargetUnavailableReason,
  type ApiSessionListItem,
} from '@agent/shared';

/** These fields form one server-owned identity bundle, never a picker-derived default. */
export type SessionAgentTargetFields = Pick<ApiSessionListItem,
  | 'agentTarget' | 'agentTargetBindingVersion' | 'agentTargetSnapshot'
  | 'agentTargetUnavailableReason' | 'orgAgentId' | 'orgAgentName' | 'orgAgentAvailable'
>;

export const SESSION_BINDING_PENDING: AgentTargetUnavailableReason = {
  code: 'session_binding_pending',
  message: '正在确认会话的 Agent 身份，请稍后重试。',
  contactAdmin: false,
};

export const SESSION_BINDING_SYNC_FAILED: AgentTargetUnavailableReason = {
  ...SESSION_BINDING_PENDING,
  message: '会话的 Agent 身份暂未确认，请刷新页面重试。',
};

/** An incomplete local WS placeholder is not evidence of a broken historical binding. */
export function sessionAgentTargetPresentation(session?: SessionAgentTargetFields | null): {
  label: string;
  unavailableReason?: AgentTargetUnavailableReason;
} {
  const reason = session?.agentTargetUnavailableReason;
  if (reason?.code === 'legacy_binding_unproven' || session?.agentTargetSnapshot?.status === 'unproven') {
    return {
      label: '绑定不可验证',
      unavailableReason: reason ?? {
        code: 'legacy_binding_unproven',
        message: '该历史会话缺少可证明的 Agent 绑定，仅支持查看。',
        contactAdmin: true,
      },
    };
  }
  if (reason?.code === 'session_binding_pending') {
    return { label: '身份待确认', unavailableReason: reason };
  }
  if (!session?.agentTarget || !session.agentTargetSnapshot) {
    return { label: '身份同步中', unavailableReason: reason ?? SESSION_BINDING_PENDING };
  }
  // A label must come from the persisted session, not the current target picker/catalog.
  const unavailableReason = reason ?? (session.agentTargetSnapshot.status !== 'available'
    ? SESSION_BINDING_SYNC_FAILED : undefined);
  return { label: session.agentTargetSnapshot.name, ...(unavailableReason ? { unavailableReason } : {}) };
}

export function needsSessionAgentTargetSync(session: SessionAgentTargetFields): boolean {
  return (!session.agentTargetUnavailableReason || session.agentTargetUnavailableReason.code === 'session_binding_pending')
    && session.agentTargetSnapshot?.status !== 'unproven'
    && (!session.agentTarget || !session.agentTargetSnapshot);
}

const IDENTITY_FIELDS = [
  'agentTarget', 'agentTargetBindingVersion', 'agentTargetSnapshot',
  'agentTargetUnavailableReason', 'orgAgentId', 'orgAgentName', 'orgAgentAvailable',
] as const;

/** Partial WS updates must not erase a previously confirmed identity with undefined fields. */
export function definedSessionAgentTargetFields(input: SessionAgentTargetFields): SessionAgentTargetFields {
  return Object.fromEntries(IDENTITY_FIELDS.flatMap((key) => (
    input[key] === undefined ? [] : [[key, input[key]]]
  ))) as SessionAgentTargetFields;
}

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

/** Backfill only an existing, still-incomplete row. Never revive a deleted row or regress a fresh list. */
export function applySessionAgentTargetIdentity(
  sessions: ApiSessionListItem[],
  sessionId: string,
  fields: SessionAgentTargetFields,
): ApiSessionListItem[] {
  let changed = false;
  const next = sessions.map((session) => {
    if (session.sessionId !== sessionId || !needsSessionAgentTargetSync(session)) return session;
    if (session.agentTarget && fields.agentTarget && !sameAgentTarget(session.agentTarget, fields.agentTarget)) {
      changed = true;
      return { ...session, agentTargetUnavailableReason: SESSION_BINDING_SYNC_FAILED };
    }
    if (fields.agentTargetSnapshot
      && (session.agentTargetSnapshot?.version ?? 0) > fields.agentTargetSnapshot.version) return session;
    changed = true;
    return { ...session, ...fields };
  });
  return changed ? next : sessions;
}
