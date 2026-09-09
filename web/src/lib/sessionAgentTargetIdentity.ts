import {
  sameAgentTarget,
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
