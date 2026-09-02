import { normalizeRunLiveness, type RunLiveness } from './runLiveness';

export type CanonicalSessionRuntimeState =
  | 'idle'
  | 'busy'
  | 'waiting_interaction'
  | 'stale'
  | 'orphaned'
  | 'terminal'
  | 'unknown';

export interface SessionRuntimeSelectorInput {
  sessionId: string;
  activeSessionId: string | null;
  runId?: string;
  liveness?: RunLiveness;
  sessionStatus?: string;
  activeStream?: { active: boolean; runId?: string };
  appVisibility: 'foreground' | 'background';
}

export interface SessionRuntimeSelection {
  state: CanonicalSessionRuntimeState;
  running: boolean;
  showSpinner: boolean;
  showRunningBadge: boolean;
  backgroundRunning: boolean;
  terminal: boolean;
  reclaim: {
    spinner: boolean;
    streamLease: boolean;
    runtimeUnread: boolean;
  };
}

const TERMINAL = new Set(['idle', 'completed', 'failed', 'cancelled']);
const ACTIVE = new Set(['busy', 'queued', 'running', 'waiting_hand']);
const WAITING = new Set(['waiting_approval', 'waiting_user']);

/**
 * Fuses server liveness, session_status and active_stream without local timeout inference.
 * App backgrounding is presentation-only and never converts a run to terminal.
 */
export function selectSessionRuntime(input: SessionRuntimeSelectorInput): SessionRuntimeSelection {
  const liveness = normalizeRunLiveness(input.liveness);
  const status = input.sessionStatus;
  const streamMatches = !input.activeStream?.runId || !input.runId || input.activeStream.runId === input.runId;
  let state: CanonicalSessionRuntimeState;
  if (liveness.state === 'terminal' || (status && TERMINAL.has(status))) state = status === 'idle' ? 'idle' : 'terminal';
  else if (liveness.state === 'orphaned' || status === 'orphaned') state = 'orphaned';
  else if (liveness.state === 'stale') state = 'stale';
  else if (liveness.state === 'waiting_interaction' || (status && WAITING.has(status))) state = 'waiting_interaction';
  else if (liveness.state === 'active' || liveness.state === 'busy' || (status && ACTIVE.has(status))
    || (input.activeStream?.active === true && streamMatches)) state = 'busy';
  else if (input.activeStream?.active === false && streamMatches) state = status ? 'idle' : 'unknown';
  else state = 'unknown';

  const running = state === 'busy';
  const terminal = state === 'terminal' || state === 'idle' || state === 'orphaned';
  const backgroundRunning = running && input.sessionId !== input.activeSessionId;
  return {
    state,
    running,
    showSpinner: running && input.sessionId === input.activeSessionId,
    showRunningBadge: running || state === 'stale' || state === 'orphaned',
    backgroundRunning,
    terminal,
    reclaim: {
      spinner: terminal,
      streamLease: terminal,
      runtimeUnread: terminal,
    },
  };
}
