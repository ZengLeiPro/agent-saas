export const AGENT_TARGET_BINDING_VERSION = 1 as const;

export type AgentTarget =
  | { kind: 'personal'; tenantId: string }
  | { kind: 'org-agent'; tenantId: string; orgAgentId: string };

/** Server-persisted display identity. Clients must never replace this with the current picker label. */
export interface AgentTargetIdentitySnapshot {
  name: string;
  status: 'available' | 'disabled' | 'revoked' | 'deleted' | 'unproven';
  /** Monotonic target/availability projection version used to fence stale events. */
  version: number;
}

export type AgentTargetUnavailableReasonCode =
  | 'personal_agent_disabled'
  | 'org_agent_unassigned'
  | 'org_agent_disabled'
  | 'org_agent_deleted'
  | 'tenant_mismatch'
  | 'legacy_binding_unproven'
  | 'no_available_target'
  | 'target_catalog_unavailable';

export interface AgentTargetUnavailableReason {
  code: AgentTargetUnavailableReasonCode;
  message: string;
  contactAdmin: boolean;
}

export type AgentTargetAvailability =
  | { status: 'available'; version?: number }
  | { status: 'unavailable'; reason: AgentTargetUnavailableReason; version?: number };

export interface AgentTargetOption<T = unknown> {
  target: AgentTarget;
  availability: AgentTargetAvailability;
  presentation?: T;
}

export interface AgentTargetCatalog<T = unknown> {
  version: 1;
  tenantId: string;
  personal: AgentTargetOption;
  orgAgents: Array<AgentTargetOption<T>>;
  selectableTargets: AgentTarget[];
  unavailableReason?: AgentTargetUnavailableReason;
}

/** Client boundary for the M20-06 catalog and the N-1 legacy array response. */
export type AgentTargetCatalogAdapterResult<T = unknown> =
  | { kind: 'catalog'; catalog: AgentTargetCatalog<T> }
  | { kind: 'legacy-unproven'; presentations: T[]; reason: AgentTargetUnavailableReason }
  | { kind: 'invalid'; reason: AgentTargetUnavailableReason };

export type AgentTargetSelection =
  | { kind: 'selected'; target: AgentTarget }
  | { kind: 'picker'; options: AgentTarget[] }
  | { kind: 'unavailable'; reason: AgentTargetUnavailableReason };

export const NO_AVAILABLE_AGENT_TARGET: AgentTargetUnavailableReason = {
  code: 'no_available_target',
  message: '暂无可用 Agent，请联系组织管理员。',
  contactAdmin: true,
};

function nonEmptyString(value: unknown, maxLength = 128): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

export function parseAgentTarget(value: unknown): AgentTarget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tenantId = nonEmptyString(record.tenantId, 64);
  if (!tenantId) return undefined;
  if (record.kind === 'personal') return { kind: 'personal', tenantId };
  if (record.kind === 'org-agent') {
    const orgAgentId = nonEmptyString(record.orgAgentId);
    return orgAgentId ? { kind: 'org-agent', tenantId, orgAgentId } : undefined;
  }
  return undefined;
}

function parseUnavailableReason(value: unknown): AgentTargetUnavailableReason | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const code = nonEmptyString(record.code) as AgentTargetUnavailableReasonCode | undefined;
  const message = nonEmptyString(record.message, 500);
  const validCodes: AgentTargetUnavailableReasonCode[] = [
    'personal_agent_disabled', 'org_agent_unassigned', 'org_agent_disabled', 'org_agent_deleted',
    'tenant_mismatch', 'legacy_binding_unproven', 'no_available_target', 'target_catalog_unavailable',
  ];
  if (!code || !validCodes.includes(code) || !message || typeof record.contactAdmin !== 'boolean') return undefined;
  return { code, message, contactAdmin: record.contactAdmin };
}

function parseAvailability(value: unknown): AgentTargetAvailability | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.status === 'available') return { status: 'available' };
  if (record.status !== 'unavailable') return undefined;
  const reason = parseUnavailableReason(record.reason);
  return reason ? { status: 'unavailable', reason } : undefined;
}

/**
 * Adapts the versioned catalog independently from the N-1 array shape. The legacy array is kept
 * only as presentation data: it cannot prove a tenant-scoped target and therefore never becomes
 * selectable (in particular, it never implies a personal target).
 */
export function adaptAgentTargetCatalogResponse<T = unknown>(
  value: unknown,
  expectedTenantId: string,
): AgentTargetCatalogAdapterResult<T> {
  const legacyReason: AgentTargetUnavailableReason = {
    code: 'legacy_binding_unproven',
    message: '服务端返回旧版 Agent 列表，无法证明租户范围内的 Agent 目标，请升级后重试。',
    contactAdmin: true,
  };
  if (Array.isArray(value)) return { kind: 'legacy-unproven', presentations: value as T[], reason: legacyReason };
  if (!value || typeof value !== 'object') {
    return { kind: 'invalid', reason: { code: 'target_catalog_unavailable', message: 'Agent 目录不可用，请稍后重试。', contactAdmin: true } };
  }
  const record = value as Record<string, unknown>;
  const tenantId = nonEmptyString(record.tenantId, 64);
  if (record.version !== 1 || !tenantId || tenantId !== expectedTenantId) {
    const tenantMismatch = !!tenantId && tenantId !== expectedTenantId;
    return {
      kind: 'invalid',
      reason: tenantMismatch
        ? { code: 'tenant_mismatch', message: 'Agent 目录与当前组织不一致，已阻止使用。', contactAdmin: true }
        : { code: 'target_catalog_unavailable', message: 'Agent 目录格式无效，请稍后重试。', contactAdmin: true },
    };
  }
  const parseOption = (candidate: unknown): AgentTargetOption<T> | undefined => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
    const option = candidate as Record<string, unknown>;
    const target = parseAgentTarget(option.target);
    const availability = parseAvailability(option.availability);
    if (!target || target.tenantId !== tenantId || !availability) return undefined;
    return { target, availability, ...(option.presentation !== undefined ? { presentation: option.presentation as T } : {}) };
  };
  const personal = parseOption(record.personal);
  const orgAgents = Array.isArray(record.orgAgents) ? record.orgAgents.map(parseOption) : [];
  const selectableTargets = Array.isArray(record.selectableTargets)
    ? record.selectableTargets.map(parseAgentTarget)
    : [];
  if (!personal || personal.target.kind !== 'personal' || orgAgents.some(option => !option || option.target.kind !== 'org-agent')
    || selectableTargets.some(target => !target || target.tenantId !== tenantId)) {
    return { kind: 'invalid', reason: { code: 'target_catalog_unavailable', message: 'Agent 目录格式无效，请稍后重试。', contactAdmin: true } };
  }
  const options = orgAgents as Array<AgentTargetOption<T>>;
  const selectable = selectableTargets as AgentTarget[];
  const available = [personal, ...options].filter(option => option.availability.status === 'available').map(option => option.target);
  if (selectable.some(target => !available.some(candidate => sameAgentTarget(candidate, target)))
    || available.some(target => !selectable.some(candidate => sameAgentTarget(candidate, target)))) {
    return { kind: 'invalid', reason: { code: 'target_catalog_unavailable', message: 'Agent 目录可选目标不一致，已阻止使用。', contactAdmin: true } };
  }
  const unavailableReason = record.unavailableReason === undefined ? undefined : parseUnavailableReason(record.unavailableReason);
  if (record.unavailableReason !== undefined && !unavailableReason) {
    return { kind: 'invalid', reason: { code: 'target_catalog_unavailable', message: 'Agent 目录不可用原因格式无效。', contactAdmin: true } };
  }
  return { kind: 'catalog', catalog: { version: 1, tenantId, personal, orgAgents: options, selectableTargets: selectable, ...(unavailableReason ? { unavailableReason } : {}) } };
}

export function sameAgentTarget(left: AgentTarget | null | undefined, right: AgentTarget | null | undefined): boolean {
  if (!left || !right || left.kind !== right.kind || left.tenantId !== right.tenantId) return false;
  return left.kind === 'personal' || (right.kind === 'org-agent' && left.orgAgentId === right.orgAgentId);
}

export function agentTargetAuditFields(target: AgentTarget): {
  targetKind: AgentTarget['kind'];
  targetId: 'personal' | string;
  targetTenantId: string;
} {
  return {
    targetKind: target.kind,
    targetId: target.kind === 'personal' ? 'personal' : target.orgAgentId,
    targetTenantId: target.tenantId,
  };
}

export function isAgentTargetAvailable<T>(catalog: AgentTargetCatalog<T>, target: AgentTarget): boolean {
  if (target.tenantId !== catalog.tenantId) return false;
  return catalog.selectableTargets.some(candidate => sameAgentTarget(candidate, target));
}

/** Canonical new-session selector shared by Web and Mobile. */
export function resolveNewSessionAgentTarget<T>(input: {
  catalog: AgentTargetCatalog<T>;
  activeTarget?: AgentTarget | null;
}): AgentTargetSelection {
  const { catalog, activeTarget } = input;
  if (activeTarget && isAgentTargetAvailable(catalog, activeTarget)) {
    return { kind: 'selected', target: activeTarget };
  }
  if (catalog.personal.availability.status === 'available') {
    return { kind: 'selected', target: catalog.personal.target };
  }
  const options = catalog.selectableTargets.filter(target => target.kind === 'org-agent');
  if (options.length === 1) return { kind: 'selected', target: options[0]! };
  if (options.length > 1) return { kind: 'picker', options };
  return { kind: 'unavailable', reason: catalog.unavailableReason ?? NO_AVAILABLE_AGENT_TARGET };
}

/**
 * 着陆页的空对话必须与「新建会话」绑定同一个默认目标，否则首条消息会被目标门禁挡下。
 * 只有目标唯一确定时才自动绑定；picker / unavailable 仍留给用户显式选择。
 */
export function resolveLandingAgentTarget<T>(input: {
  catalog: AgentTargetCatalog<T> | null;
  catalogLoading: boolean;
  hasSession: boolean;
  hasPendingTarget: boolean;
  hasMessages: boolean;
}): AgentTarget | null {
  if (input.catalogLoading || !input.catalog) return null;
  if (input.hasSession || input.hasPendingTarget || input.hasMessages) return null;
  const selection = resolveNewSessionAgentTarget({ catalog: input.catalog });
  return selection.kind === 'selected' ? selection.target : null;
}

/**
 * Changing target never silently reuses a differently-bound session. A caller may explicitly
 * provide an already-selected matching session; otherwise the only safe action is a new session.
 */
export function resolveTargetSessionAction(input: {
  target: AgentTarget;
  current?: { sessionId: string; target?: AgentTarget } | null;
  explicitMatchingSession?: { sessionId: string; target?: AgentTarget } | null;
}): { kind: 'reuse'; sessionId: string } | { kind: 'new-session'; target: AgentTarget } {
  if (input.current?.target && sameAgentTarget(input.current.target, input.target)) {
    return { kind: 'reuse', sessionId: input.current.sessionId };
  }
  if (input.explicitMatchingSession?.target && sameAgentTarget(input.explicitMatchingSession.target, input.target)) {
    return { kind: 'reuse', sessionId: input.explicitMatchingSession.sessionId };
  }
  return { kind: 'new-session', target: input.target };
}
