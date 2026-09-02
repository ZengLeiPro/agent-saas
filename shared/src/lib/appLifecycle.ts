/** M50-05 canonical foreground/background and weak-network recovery state machine. */

export type CanonicalAppState = 'active' | 'inactive' | 'background';
export type InternetReachability = true | false | null;
export type CanonicalLifecyclePhase =
  | 'offline'
  | 'probing'
  | 'connecting'
  | 'syncing'
  | 'attached'
  | 'ready'
  | 'suspended'
  | 'degraded';

export type CanonicalWsLifecycleState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export type CanonicalRecoveryStep =
  | 'auth_journal'
  | 'reachability'
  | 'ws_auth'
  | 'sync'
  | 'queue_snapshot'
  | 'attach_active_stream'
  | 'restore_interactions'
  | 'complete';

export interface CanonicalLifecycleInput {
  appState: CanonicalAppState;
  isConnected: boolean;
  /** NetInfo's authoritative field. null is unknown and is never treated as reachable. */
  isInternetReachable: InternetReachability;
  networkGeneration: number;
  networkType: string;
  authGeneration: number;
  authEpoch: number;
  appProtocolVersion: number;
  schemaVersion: number;
  wsState: CanonicalWsLifecycleState;
  queueHydrated: boolean;
  runtimeAttached: boolean;
  activeRun: boolean;
  recording: boolean;
  ttsPlaying: boolean;
  nonEssentialUploadActive: boolean;
  nowMs: number;
}

export interface LifecycleFence {
  cycle: number;
  networkGeneration: number;
  authGeneration: number;
  authEpoch: number;
  appProtocolVersion: number;
  schemaVersion: number;
}

export type CanonicalLifecycleEffectKind =
  | 'suspend_nonessential'
  | 'detach_background'
  | 'recover_auth_journal'
  | 'probe_reachability'
  | 'connect_ws_auth'
  | 'sync_seq_epoch'
  | 'fetch_queue_snapshot'
  | 'attach_active_stream'
  | 'restore_interactions';

export interface CanonicalLifecycleEffect {
  id: string;
  kind: CanonicalLifecycleEffectKind;
  requestId?: string;
  fence: LifecycleFence;
  /** One background effect atomically stops media/work and pauses transport activity. */
  suspend?: {
    stopRecording: boolean;
    stopTts: boolean;
    pauseNonEssentialUploads: boolean;
    pauseHeartbeat: true;
    pausePolling: true;
    preventNewWebSocket: true;
    cancelActiveRun: false;
  };
}

interface LifecycleBudgetEntry { at: number; request: number; energy: number }

export interface CanonicalLifecyclePolicy {
  debounceMs: number;
  backgroundGraceMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  budgetWindowMs: number;
  maxRequestsPerWindow: number;
  maxEnergyPerWindow: number;
}

export const DEFAULT_LIFECYCLE_POLICY: CanonicalLifecyclePolicy = Object.freeze({
  debounceMs: 750,
  backgroundGraceMs: 3_000,
  baseBackoffMs: 500,
  maxBackoffMs: 30_000,
  budgetWindowMs: 60_000,
  maxRequestsPerWindow: 12,
  maxEnergyPerWindow: 24,
});

export interface CanonicalLifecycleState {
  phase: CanonicalLifecyclePhase;
  step: CanonicalRecoveryStep;
  cycle: number;
  networkGeneration: number;
  networkType: string;
  authGeneration: number;
  authEpoch: number;
  appProtocolVersion: number;
  schemaVersion: number;
  effect: CanonicalLifecycleEffect | null;
  attempt: number;
  nextAttemptAt: number;
  debounceUntil: number;
  backgroundedAt: number | null;
  backgroundDetached: boolean;
  budgets: LifecycleBudgetEntry[];
  degradedReason?: 'request_budget' | 'energy_budget' | 'retry_backoff' | 'effect_failed';
}

export type CanonicalLifecycleEvent =
  | { type: 'observe'; input: CanonicalLifecycleInput }
  | { type: 'effect_succeeded'; effectId: string; nowMs: number }
  | { type: 'effect_failed'; effectId: string; nowMs: number; retryAfterMs?: number; randomUnit?: number };

const NEXT_STEP: Record<Exclude<CanonicalRecoveryStep, 'complete'>, CanonicalRecoveryStep> = {
  auth_journal: 'reachability',
  reachability: 'ws_auth',
  ws_auth: 'sync',
  sync: 'queue_snapshot',
  queue_snapshot: 'attach_active_stream',
  attach_active_stream: 'restore_interactions',
  restore_interactions: 'complete',
};

const STEP_EFFECT: Record<Exclude<CanonicalRecoveryStep, 'complete'>, CanonicalLifecycleEffectKind> = {
  auth_journal: 'recover_auth_journal',
  reachability: 'probe_reachability',
  ws_auth: 'connect_ws_auth',
  sync: 'sync_seq_epoch',
  queue_snapshot: 'fetch_queue_snapshot',
  attach_active_stream: 'attach_active_stream',
  restore_interactions: 'restore_interactions',
};

const EFFECT_COST: Record<CanonicalLifecycleEffectKind, { request: number; energy: number }> = {
  suspend_nonessential: { request: 0, energy: 0 },
  detach_background: { request: 0, energy: 0 },
  recover_auth_journal: { request: 0, energy: 1 },
  probe_reachability: { request: 1, energy: 1 },
  connect_ws_auth: { request: 1, energy: 4 },
  sync_seq_epoch: { request: 1, energy: 3 },
  fetch_queue_snapshot: { request: 1, energy: 2 },
  attach_active_stream: { request: 1, energy: 2 },
  restore_interactions: { request: 1, energy: 1 },
};

function validGeneration(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sameBoundary(state: CanonicalLifecycleState, input: CanonicalLifecycleInput): boolean {
  return state.networkGeneration === validGeneration(input.networkGeneration)
    && state.authGeneration === validGeneration(input.authGeneration)
    && state.authEpoch === validGeneration(input.authEpoch)
    && state.appProtocolVersion === validGeneration(input.appProtocolVersion)
    && state.schemaVersion === validGeneration(input.schemaVersion);
}

function fence(state: CanonicalLifecycleState): LifecycleFence {
  return {
    cycle: state.cycle,
    networkGeneration: state.networkGeneration,
    authGeneration: state.authGeneration,
    authEpoch: state.authEpoch,
    appProtocolVersion: state.appProtocolVersion,
    schemaVersion: state.schemaVersion,
  };
}

function effectId(state: CanonicalLifecycleState, kind: CanonicalLifecycleEffectKind): string {
  return `${state.cycle}:${state.networkGeneration}:${state.authGeneration}:${kind}:${state.step}`;
}

function phaseForStep(step: CanonicalRecoveryStep): CanonicalLifecyclePhase {
  if (step === 'auth_journal' || step === 'reachability') return 'probing';
  if (step === 'ws_auth') return 'connecting';
  if (step === 'sync' || step === 'queue_snapshot') return 'syncing';
  if (step === 'attach_active_stream' || step === 'restore_interactions') return 'attached';
  return 'ready';
}

function trimBudgets(state: CanonicalLifecycleState, nowMs: number, policy: CanonicalLifecyclePolicy): CanonicalLifecycleState {
  const budgets = state.budgets.filter((entry) => nowMs - entry.at < policy.budgetWindowMs);
  return budgets.length === state.budgets.length ? state : { ...state, budgets };
}

function issue(
  state: CanonicalLifecycleState,
  kind: CanonicalLifecycleEffectKind,
  nowMs: number,
  policy: CanonicalLifecyclePolicy,
): CanonicalLifecycleState {
  if (state.effect) return state;
  const trimmed = trimBudgets(state, nowMs, policy);
  const cost = EFFECT_COST[kind];
  const requests = trimmed.budgets.reduce((sum, item) => sum + item.request, 0);
  const energy = trimmed.budgets.reduce((sum, item) => sum + item.energy, 0);
  if (requests + cost.request > policy.maxRequestsPerWindow) {
    return { ...trimmed, phase: 'degraded', degradedReason: 'request_budget' };
  }
  if (energy + cost.energy > policy.maxEnergyPerWindow) {
    return { ...trimmed, phase: 'degraded', degradedReason: 'energy_budget' };
  }
  const id = effectId(trimmed, kind);
  const requestId = cost.request > 0 ? `lifecycle:${id}` : undefined;
  const nextEffect: CanonicalLifecycleEffect = {
    id,
    kind,
    ...(requestId ? { requestId } : {}),
    fence: fence(trimmed),
    ...(kind === 'suspend_nonessential' ? {
      suspend: {
        stopRecording: true,
        stopTts: true,
        pauseNonEssentialUploads: true,
        pauseHeartbeat: true,
        pausePolling: true,
        preventNewWebSocket: true,
        cancelActiveRun: false,
      },
    } : {}),
  };
  return {
    ...trimmed,
    effect: nextEffect,
    budgets: cost.request || cost.energy
      ? [...trimmed.budgets, { at: nowMs, ...cost }]
      : trimmed.budgets,
    degradedReason: undefined,
  };
}

function restartForBoundary(
  state: CanonicalLifecycleState,
  input: CanonicalLifecycleInput,
  policy: CanonicalLifecyclePolicy,
): CanonicalLifecycleState {
  const networkChanged = state.networkGeneration !== validGeneration(input.networkGeneration);
  return {
    ...state,
    phase: input.appState === 'active' ? 'probing' : 'suspended',
    step: 'auth_journal',
    cycle: state.cycle + 1,
    networkGeneration: validGeneration(input.networkGeneration),
    networkType: input.networkType,
    authGeneration: validGeneration(input.authGeneration),
    authEpoch: validGeneration(input.authEpoch),
    appProtocolVersion: validGeneration(input.appProtocolVersion),
    schemaVersion: validGeneration(input.schemaVersion),
    effect: null,
    attempt: 0,
    nextAttemptAt: 0,
    debounceUntil: networkChanged ? input.nowMs + policy.debounceMs : input.nowMs,
    backgroundedAt: input.appState === 'active' ? null : input.nowMs,
    backgroundDetached: false,
    degradedReason: undefined,
  };
}

export function createCanonicalLifecycleState(input: CanonicalLifecycleInput): CanonicalLifecycleState {
  return {
    phase: input.appState === 'active' ? (input.isInternetReachable === false ? 'offline' : 'probing') : 'suspended',
    step: 'auth_journal',
    cycle: 1,
    networkGeneration: validGeneration(input.networkGeneration),
    networkType: input.networkType,
    authGeneration: validGeneration(input.authGeneration),
    authEpoch: validGeneration(input.authEpoch),
    appProtocolVersion: validGeneration(input.appProtocolVersion),
    schemaVersion: validGeneration(input.schemaVersion),
    effect: null,
    attempt: 0,
    nextAttemptAt: 0,
    debounceUntil: input.nowMs,
    backgroundedAt: input.appState === 'active' ? null : input.nowMs,
    backgroundDetached: false,
    budgets: [],
  };
}

function observe(
  original: CanonicalLifecycleState,
  input: CanonicalLifecycleInput,
  policy: CanonicalLifecyclePolicy,
): CanonicalLifecycleState {
  let state = trimBudgets(original, input.nowMs, policy);
  if (!sameBoundary(state, input)) state = restartForBoundary(state, input, policy);
  else if (state.networkType !== input.networkType) state = { ...state, networkType: input.networkType };

  if (input.appState !== 'active') {
    if (state.phase !== 'suspended' || state.backgroundedAt === null) {
      state = {
        ...state,
        phase: 'suspended',
        effect: null,
        cycle: state.cycle + 1,
        backgroundedAt: input.nowMs,
        backgroundDetached: false,
      };
      return issue(state, 'suspend_nonessential', input.nowMs, policy);
    }
    if (!state.effect && !state.backgroundDetached
      && input.nowMs - state.backgroundedAt >= policy.backgroundGraceMs) {
      return issue(state, 'detach_background', input.nowMs, policy);
    }
    return state;
  }

  if (state.backgroundedAt !== null) {
    state = {
      ...state,
      phase: 'probing',
      step: 'auth_journal',
      cycle: state.cycle + 1,
      effect: null,
      attempt: 0,
      nextAttemptAt: 0,
      debounceUntil: input.nowMs,
      backgroundedAt: null,
      backgroundDetached: false,
      degradedReason: undefined,
    };
  }

  // isConnected is diagnostic only; transport work is gated solely by strict reachability.
  if (input.isInternetReachable === false) return { ...state, phase: 'offline', effect: null };
  if (state.nextAttemptAt > input.nowMs) return { ...state, phase: 'degraded', degradedReason: 'retry_backoff' };
  if (state.effect) return state;

  if (state.step === 'complete') return { ...state, phase: 'ready', attempt: 0, degradedReason: undefined };
  if (state.step === 'reachability' && input.nowMs < state.debounceUntil) {
    return { ...state, phase: 'probing' };
  }
  // true allows transport after an explicit probe stage; null allows only the probe itself.
  if (input.isInternetReachable === null && state.step !== 'auth_journal' && state.step !== 'reachability') {
    return { ...state, phase: 'probing' };
  }
  return issue({ ...state, phase: phaseForStep(state.step) }, STEP_EFFECT[state.step], input.nowMs, policy);
}

export function reduceCanonicalLifecycle(
  state: CanonicalLifecycleState,
  event: CanonicalLifecycleEvent,
  policy: CanonicalLifecyclePolicy = DEFAULT_LIFECYCLE_POLICY,
): CanonicalLifecycleState {
  if (event.type === 'observe') return observe(state, event.input, policy);
  if (!state.effect || state.effect.id !== event.effectId) return state; // generation/cycle fence

  const completedKind = state.effect.kind;
  if (event.type === 'effect_failed') {
    const random = Math.min(1, Math.max(0, event.randomUnit ?? Math.random()));
    const exponentialCap = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * (2 ** Math.min(state.attempt, 20)));
    // Full jitter in [0, exponentialCap]; Retry-After is authoritative when longer.
    const delay = Math.max(Math.max(0, event.retryAfterMs ?? 0), Math.floor(random * exponentialCap));
    return {
      ...state,
      effect: null,
      phase: 'degraded',
      attempt: state.attempt + 1,
      nextAttemptAt: event.nowMs + delay,
      degradedReason: 'effect_failed',
    };
  }

  if (completedKind === 'suspend_nonessential') return { ...state, effect: null, phase: 'suspended' };
  if (completedKind === 'detach_background') return { ...state, effect: null, phase: 'suspended', backgroundDetached: true };
  if (state.step === 'complete') return { ...state, effect: null, phase: 'ready', attempt: 0 };
  const step = NEXT_STEP[state.step];
  return {
    ...state,
    effect: null,
    step,
    phase: phaseForStep(step),
    attempt: completedKind === 'connect_ws_auth' ? 0 : state.attempt,
    nextAttemptAt: 0,
    degradedReason: undefined,
  };
}

export function lifecycleAllowsDispatch(state: CanonicalLifecycleState): boolean {
  return state.phase === 'ready' && state.step === 'complete' && state.effect === null;
}

export interface LifecyclePresentation {
  state: 'offline' | 'reconnecting' | 'syncing' | 'ready' | 'degraded';
  action: 'recover' | null;
  dispatchEnabled: boolean;
}

/** UI has exactly one recovery action; send/steer/replay stay fenced until ready. */
export function presentCanonicalLifecycle(state: CanonicalLifecycleState): LifecyclePresentation {
  const uiState = state.phase === 'offline' ? 'offline'
    : state.phase === 'syncing' || state.phase === 'attached' ? 'syncing'
    : state.phase === 'ready' ? 'ready'
    : state.phase === 'degraded' ? 'degraded'
    : 'reconnecting';
  return {
    state: uiState,
    action: uiState === 'ready' ? null : 'recover',
    dispatchEnabled: lifecycleAllowsDispatch(state),
  };
}

export function lifecycleBudgetUsage(
  state: CanonicalLifecycleState,
  nowMs: number,
  policy: CanonicalLifecyclePolicy = DEFAULT_LIFECYCLE_POLICY,
): { requests: number; energy: number } {
  return state.budgets
    .filter((entry) => nowMs - entry.at < policy.budgetWindowMs)
    .reduce((sum, entry) => ({ requests: sum.requests + entry.request, energy: sum.energy + entry.energy }), { requests: 0, energy: 0 });
}
