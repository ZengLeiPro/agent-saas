import { sameAgentTarget, type AgentTarget, type AgentTargetAvailability } from './agentTarget';
import type { ChatQueueSnapshot, ChatQueueStatus } from './chatQueue';
import type { RunLiveness } from './runLiveness';
import type { SessionListActiveInteraction } from '../types/session';

/** M30-03 canonical Agent switch contract. Platform adapters must not reinterpret this decision. */
export type AgentTargetSwitchChoice = 'keep-old-open' | 'cancel-active';

export interface PersistentSessionAgentTarget {
  sessionId: string;
  target: AgentTarget;
  bindingVersion: number;
}

export interface AgentTargetTransitionInput {
  currentSession: PersistentSessionAgentTarget | null;
  requestedTarget: AgentTarget;
  runLiveness: RunLiveness;
  queueSnapshot: ChatQueueSnapshot | null;
  pendingInteraction: SessionListActiveInteraction | null;
  availability: AgentTargetAvailability;
  /** Authentication/session generation. Events from an older generation are fenced. */
  generation: number;
  /** Monotonic availability/target event version. */
  availabilityVersion: number;
}

export type AgentTargetTransitionImpact =
  | { kind: 'running'; liveness: RunLiveness['state'] }
  | { kind: 'queued'; count: number; clientMsgIds: string[] }
  | { kind: 'pending-interaction'; interactionId: string; version: number };

export type AgentTargetTransitionDecision =
  | { kind: 'reuse'; sessionId: string; target: AgentTarget }
  | { kind: 'new-session'; target: AgentTarget; previousSessionId?: string }
  | {
      kind: 'needs-confirmation';
      target: AgentTarget;
      previousSessionId: string;
      impacts: AgentTargetTransitionImpact[];
      choices: readonly AgentTargetSwitchChoice[];
    }
  | { kind: 'blocked'; target: AgentTarget; reason: Extract<AgentTargetAvailability, { status: 'unavailable' }>['reason'] };

const ACTIVE_LIVENESS = new Set<RunLiveness['state']>([
  'active', 'busy', 'waiting_interaction', 'stale', 'orphaned',
]);
const ACTIVE_QUEUE = new Set<ChatQueueStatus>(['queued', 'running', 'cancel_pending']);

export function collectAgentTargetTransitionImpacts(input: Pick<
  AgentTargetTransitionInput,
  'runLiveness' | 'queueSnapshot' | 'pendingInteraction'
>): AgentTargetTransitionImpact[] {
  const impacts: AgentTargetTransitionImpact[] = [];
  if (ACTIVE_LIVENESS.has(input.runLiveness.state)) {
    impacts.push({ kind: 'running', liveness: input.runLiveness.state });
  }
  const queued = input.queueSnapshot?.items.filter(item => ACTIVE_QUEUE.has(item.status)) ?? [];
  if (queued.length > 0) {
    impacts.push({ kind: 'queued', count: queued.length, clientMsgIds: queued.map(item => item.clientMsgId) });
  }
  if (input.pendingInteraction) {
    impacts.push({
      kind: 'pending-interaction',
      interactionId: input.pendingInteraction.interactionId,
      version: input.pendingInteraction.version,
    });
  }
  return impacts;
}

/**
 * Same target may reuse its persisted session. A different target always creates a new session;
 * active work requires an explicit choice first. Availability fails closed before either action.
 */
export function evaluateAgentTargetTransition(input: AgentTargetTransitionInput): AgentTargetTransitionDecision {
  if (input.availability.status === 'unavailable') {
    return { kind: 'blocked', target: input.requestedTarget, reason: input.availability.reason };
  }
  const current = input.currentSession;
  if (current && sameAgentTarget(current.target, input.requestedTarget)) {
    return { kind: 'reuse', sessionId: current.sessionId, target: current.target };
  }
  if (!current) return { kind: 'new-session', target: input.requestedTarget };
  const impacts = collectAgentTargetTransitionImpacts(input);
  if (impacts.length > 0) {
    return {
      kind: 'needs-confirmation',
      target: input.requestedTarget,
      previousSessionId: current.sessionId,
      impacts,
      choices: ['keep-old-open', 'cancel-active'],
    };
  }
  return { kind: 'new-session', target: input.requestedTarget, previousSessionId: current.sessionId };
}

export type AgentTargetTransitionState =
  | { phase: 'decision'; input: AgentTargetTransitionInput; decision: AgentTargetTransitionDecision }
  | {
      phase: 'awaiting-canonical-terminal';
      input: AgentTargetTransitionInput;
      impacts: AgentTargetTransitionImpact[];
      choice: 'cancel-active';
    }
  | { phase: 'ready'; input: AgentTargetTransitionInput; decision: Extract<AgentTargetTransitionDecision, { kind: 'reuse' | 'new-session' }> }
  | { phase: 'blocked'; input: AgentTargetTransitionInput; decision: Extract<AgentTargetTransitionDecision, { kind: 'blocked' }>; reason: 'unavailable' }
  | { phase: 'cancel-failed'; input: AgentTargetTransitionInput; impacts: AgentTargetTransitionImpact[]; reason: string };

export type AgentTargetTransitionEvent =
  | { type: 'choose'; choice: AgentTargetSwitchChoice }
  | {
      type: 'canonical-snapshot';
      generation: number;
      availabilityVersion: number;
      runLiveness: RunLiveness;
      queueSnapshot: ChatQueueSnapshot | null;
      pendingInteraction: SessionListActiveInteraction | null;
      availability: AgentTargetAvailability;
    }
  | { type: 'cancel-failed'; generation: number; reason: string };

export function createAgentTargetTransition(input: AgentTargetTransitionInput): AgentTargetTransitionState {
  const decision = evaluateAgentTargetTransition(input);
  if (decision.kind === 'blocked') return { phase: 'blocked', input, decision, reason: 'unavailable' };
  if (decision.kind === 'reuse' || decision.kind === 'new-session') return { phase: 'ready', input, decision };
  return { phase: 'decision', input, decision };
}

/**
 * `cancel-active` never commits on click or transport success. Only a same-generation canonical
 * snapshot with no live run/queue/interaction can advance to `ready`.
 */
export function reduceAgentTargetTransition(
  state: AgentTargetTransitionState,
  event: AgentTargetTransitionEvent,
): AgentTargetTransitionState {
  if (event.type === 'cancel-failed') {
    if (event.generation !== state.input.generation || state.phase !== 'awaiting-canonical-terminal') return state;
    return { phase: 'cancel-failed', input: state.input, impacts: state.impacts, reason: event.reason };
  }
  if (event.type === 'choose') {
    if (state.phase !== 'decision' || state.decision.kind !== 'needs-confirmation') return state;
    if (event.choice === 'keep-old-open') {
      return {
        phase: 'ready',
        input: state.input,
        decision: {
          kind: 'new-session',
          target: state.input.requestedTarget,
          previousSessionId: state.input.currentSession?.sessionId,
        },
      };
    }
    return {
      phase: 'awaiting-canonical-terminal',
      input: state.input,
      impacts: state.decision.impacts,
      choice: 'cancel-active',
    };
  }
  if (event.generation !== state.input.generation || event.availabilityVersion < state.input.availabilityVersion) return state;
  const input: AgentTargetTransitionInput = {
    ...state.input,
    generation: event.generation,
    availabilityVersion: event.availabilityVersion,
    runLiveness: event.runLiveness,
    queueSnapshot: event.queueSnapshot,
    pendingInteraction: event.pendingInteraction,
    availability: event.availability,
  };
  const decision = evaluateAgentTargetTransition(input);
  if (decision.kind === 'blocked') return { phase: 'blocked', input, decision, reason: 'unavailable' };
  if (state.phase === 'awaiting-canonical-terminal') {
    const impacts = collectAgentTargetTransitionImpacts(input);
    if (impacts.length > 0) return { ...state, input, impacts };
    return {
      phase: 'ready',
      input,
      decision: {
        kind: 'new-session',
        target: input.requestedTarget,
        previousSessionId: input.currentSession?.sessionId,
      },
    };
  }
  return createAgentTargetTransition(input);
}

export function canCommitAgentTargetTransition(state: AgentTargetTransitionState): state is Extract<AgentTargetTransitionState, { phase: 'ready' }> {
  return state.phase === 'ready';
}
