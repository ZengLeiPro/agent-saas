/** Server-owned M40-02 run-liveness wire contract. */
export const RUN_LIVENESS_VERSION = 1 as const;

export type RunLivenessState =
  | 'unknown'
  | 'active'
  | 'busy'
  | 'waiting_interaction'
  | 'stale'
  | 'orphaned'
  | 'terminal';

export type RunLivenessRecoveryAction = 'retry' | 'cancel';

export interface RunLiveness {
  state: RunLivenessState;
  lastHeartbeatAt?: string;
  leaseExpiresAt?: string;
  ownerId?: string;
  reasonCode?: string;
  recoveryActions: RunLivenessRecoveryAction[];
  detectedAt?: string;
  /** Contract version, not an event ordering counter. */
  version: number;
}

export const UNKNOWN_RUN_LIVENESS: Readonly<RunLiveness> = Object.freeze({
  state: 'unknown',
  recoveryActions: [],
  version: 0,
});

const STATES = new Set<RunLivenessState>([
  'unknown', 'active', 'busy', 'waiting_interaction', 'stale', 'orphaned', 'terminal',
]);
const ACTIONS = new Set<RunLivenessRecoveryAction>(['retry', 'cancel']);
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Boundary normalizer. Missing/legacy/malformed DTOs fail closed to unknown; clients do not infer
 * liveness from status, timestamps, websocket silence, or local timeouts.
 */
export function normalizeRunLiveness(value: unknown): RunLiveness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...UNKNOWN_RUN_LIVENESS };
  const input = value as Record<string, unknown>;
  if (typeof input.version !== 'number' || !Number.isInteger(input.version)
    || input.version < RUN_LIVENESS_VERSION || !STATES.has(input.state as RunLivenessState)
    || !Array.isArray(input.recoveryActions)) {
    return { ...UNKNOWN_RUN_LIVENESS };
  }
  const recoveryActions = [...new Set(input.recoveryActions.filter(
    (action): action is RunLivenessRecoveryAction => ACTIONS.has(action as RunLivenessRecoveryAction),
  ))];
  const state = input.state as RunLivenessState;
  // external tool completion is unknowable: never expose retry even if a bad/older server sent it.
  const reasonCode = optionalString(input.reasonCode);
  const safeActions = reasonCode === 'external_tool_outcome_unknown'
    ? recoveryActions.filter((action) => action === 'cancel')
    : recoveryActions;
  return {
    state,
    ...(optionalString(input.lastHeartbeatAt) ? { lastHeartbeatAt: optionalString(input.lastHeartbeatAt) } : {}),
    ...(optionalString(input.leaseExpiresAt) ? { leaseExpiresAt: optionalString(input.leaseExpiresAt) } : {}),
    ...(optionalString(input.ownerId) ? { ownerId: optionalString(input.ownerId) } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    recoveryActions: state === 'terminal' || state === 'unknown' ? [] : safeActions,
    ...(optionalString(input.detectedAt) ? { detectedAt: optionalString(input.detectedAt) } : {}),
    version: input.version,
  };
}

/** Sticky merge for same-run projections. A new run must use a new runId. */
export function mergeRunLiveness(currentValue: unknown, incomingValue: unknown): RunLiveness {
  const current = normalizeRunLiveness(currentValue);
  const incoming = normalizeRunLiveness(incomingValue);
  if (current.state === 'unknown') return incoming;
  if (incoming.state === 'unknown') return current;
  if (current.state === 'terminal') return current;
  if (current.state === 'orphaned') return incoming.state === 'terminal' ? incoming : current;
  if (current.state === 'stale') {
    return incoming.state === 'terminal' || incoming.state === 'orphaned' ? incoming : current;
  }
  return incoming;
}

export interface RunLivenessProjectionState {
  generation: number;
  epoch: string | null;
  bySession: Readonly<Record<string, Readonly<Record<string, RunLiveness>>>>;
}

export type RunLivenessProjectionAction =
  | { type: 'identity_boundary'; generation: number; epoch?: string | null }
  | { type: 'epoch_boundary'; generation: number; epoch: string | null }
  | {
      type: 'observe';
      generation: number;
      epoch?: string | null;
      sessionId: string;
      runId: string;
      liveness?: unknown;
    };

export function createRunLivenessProjectionState(
  generation = 0,
  epoch: string | null = null,
): RunLivenessProjectionState {
  return { generation, epoch, bySession: {} };
}

/** Identity/generation + epoch + session/run fenced liveness reducer. */
export function reduceRunLivenessProjection(
  state: RunLivenessProjectionState,
  action: RunLivenessProjectionAction,
): RunLivenessProjectionState {
  if (action.type === 'identity_boundary') {
    if (action.generation === state.generation && (action.epoch ?? state.epoch) === state.epoch) return state;
    return createRunLivenessProjectionState(action.generation, action.epoch ?? null);
  }
  if (action.generation !== state.generation) return state;
  if (action.type === 'epoch_boundary') {
    if (action.epoch === state.epoch) return state;
    return createRunLivenessProjectionState(state.generation, action.epoch);
  }
  if (action.epoch !== undefined && state.epoch !== null && action.epoch !== state.epoch) return state;
  if (!action.sessionId || !action.runId) return state;
  const session = state.bySession[action.sessionId] ?? {};
  const current = session[action.runId];
  const next = mergeRunLiveness(current, action.liveness);
  if (current && JSON.stringify(current) === JSON.stringify(next)) return state;
  return {
    ...state,
    bySession: {
      ...state.bySession,
      [action.sessionId]: { ...session, [action.runId]: next },
    },
  };
}

export function selectProjectedRunLiveness(
  state: RunLivenessProjectionState,
  sessionId: string,
  runId: string,
): RunLiveness {
  return normalizeRunLiveness(state.bySession[sessionId]?.[runId]);
}

export interface RunLivenessPresentation {
  state: RunLivenessState;
  label: string;
  running: boolean;
  waitingInteraction: boolean;
  uncertain: boolean;
  terminal: boolean;
}

/** Exact cross-platform wording; unknown is the N-1 safe degradation. */
export function selectRunLivenessPresentation(value: unknown): RunLivenessPresentation {
  const { state } = normalizeRunLiveness(value);
  switch (state) {
    case 'active':
    case 'busy':
      return { state, label: '仍在运行', running: true, waitingInteraction: false, uncertain: false, terminal: false };
    case 'waiting_interaction':
      return { state, label: '等待操作', running: false, waitingInteraction: true, uncertain: false, terminal: false };
    case 'stale':
      return { state, label: '连接中断/正在确认', running: false, waitingInteraction: false, uncertain: true, terminal: false };
    case 'orphaned':
      return { state, label: '需要重试或取消', running: false, waitingInteraction: false, uncertain: true, terminal: true };
    case 'terminal':
      return { state, label: '完成/失败', running: false, waitingInteraction: false, uncertain: false, terminal: true };
    default:
      return { state: 'unknown', label: '状态待确认', running: false, waitingInteraction: false, uncertain: true, terminal: false };
  }
}

export interface RunRecoveryGate {
  online: boolean;
  locallyUnlocked: boolean;
  identityFenceCurrent?: boolean;
  epochFenceCurrent?: boolean;
  sessionFenceCurrent?: boolean;
}

export interface RunRecoverySelection {
  actions: RunLivenessRecoveryAction[];
  canRetry: boolean;
  canCancel: boolean;
  manualInspectionRequired: boolean;
  blockedReason?: 'offline' | 'locked' | 'stale_fence' | 'server_disallowed';
}

/** Recovery is an explicit user action and always intersects the server allow-list. */
export function selectRunLivenessRecovery(value: unknown, gate: RunRecoveryGate): RunRecoverySelection {
  const liveness = normalizeRunLiveness(value);
  const manualInspectionRequired = liveness.reasonCode === 'external_tool_outcome_unknown';
  let blockedReason: RunRecoverySelection['blockedReason'];
  if (!gate.online) blockedReason = 'offline';
  else if (!gate.locallyUnlocked) blockedReason = 'locked';
  else if (gate.identityFenceCurrent === false || gate.epochFenceCurrent === false || gate.sessionFenceCurrent === false) blockedReason = 'stale_fence';
  const actions = blockedReason ? [] : liveness.recoveryActions.filter((action) => (
    !(manualInspectionRequired && action === 'retry')
  ));
  if (!blockedReason && actions.length === 0) blockedReason = 'server_disallowed';
  return {
    actions,
    canRetry: actions.includes('retry'),
    canCancel: actions.includes('cancel'),
    manualInspectionRequired,
    ...(blockedReason ? { blockedReason } : {}),
  };
}
