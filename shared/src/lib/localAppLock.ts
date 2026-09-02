/** M30-02 pure, platform-agnostic local app-lock state machine. */
export const DEFAULT_LOCAL_LOCK_BACKGROUND_MS = 30_000;
export const SYSTEM_PROMPT_GRACE_MS = 5_000;

export type LocalAppAccess = 'full' | 'locked' | 'offline-shell';

export interface LocalAppLockState {
  enabled: boolean;
  access: LocalAppAccess;
  backgroundAt: number | null;
  promptInFlight: boolean;
  suppressUntil: number;
  failure: 'cancelled' | 'failed' | 'lockout' | null;
}

export type LocalAppLockEvent =
  | { type: 'configure'; enabled: boolean }
  | { type: 'background'; now: number; systemPrompt?: boolean }
  | { type: 'foreground'; now: number; thresholdMs?: number }
  | { type: 'lock' }
  | { type: 'prompt-start'; now: number }
  | { type: 'prompt-success'; serverSessionValid: boolean; offline: boolean }
  | { type: 'prompt-failure'; reason: 'cancelled' | 'failed' | 'lockout' }
  | { type: 'identity-boundary' };

export const INITIAL_LOCAL_APP_LOCK_STATE: LocalAppLockState = Object.freeze({
  enabled: false,
  access: 'full',
  backgroundAt: null,
  promptInFlight: false,
  suppressUntil: 0,
  failure: null,
});

export function localAppLockReducer(
  state: LocalAppLockState,
  event: LocalAppLockEvent,
): LocalAppLockState {
  switch (event.type) {
    case 'configure':
      return {
        ...INITIAL_LOCAL_APP_LOCK_STATE,
        enabled: event.enabled,
        access: event.enabled ? 'locked' : 'full',
      };
    case 'background':
      return {
        ...state,
        backgroundAt: state.backgroundAt ?? event.now,
        suppressUntil: event.systemPrompt
          ? Math.max(state.suppressUntil, event.now + SYSTEM_PROMPT_GRACE_MS)
          : state.suppressUntil,
      };
    case 'foreground': {
      if (!state.enabled || state.backgroundAt === null) {
        return { ...state, backgroundAt: null };
      }
      const elapsed = Math.max(0, event.now - state.backgroundAt);
      const threshold = event.thresholdMs ?? DEFAULT_LOCAL_LOCK_BACKGROUND_MS;
      const shouldLock = event.now > state.suppressUntil && elapsed >= threshold;
      return {
        ...state,
        access: shouldLock ? 'locked' : state.access,
        backgroundAt: null,
        failure: shouldLock ? null : state.failure,
      };
    }
    case 'lock':
      return state.enabled
        ? { ...state, access: 'locked', promptInFlight: false, failure: null }
        : state;
    case 'prompt-start':
      if (!state.enabled || state.access !== 'locked' || state.promptInFlight) return state;
      return {
        ...state,
        promptInFlight: true,
        suppressUntil: Math.max(state.suppressUntil, event.now + SYSTEM_PROMPT_GRACE_MS),
        failure: null,
      };
    case 'prompt-success':
      if (!state.promptInFlight) return state;
      return {
        ...state,
        access: event.serverSessionValid ? 'full' : event.offline ? 'offline-shell' : 'locked',
        promptInFlight: false,
        failure: event.serverSessionValid || event.offline ? null : 'failed',
      };
    case 'prompt-failure':
      if (!state.promptInFlight) return state;
      return { ...state, promptInFlight: false, failure: event.reason };
    case 'identity-boundary':
      return INITIAL_LOCAL_APP_LOCK_STATE;
  }
}

export function canUseSensitiveTransport(state: LocalAppLockState): boolean {
  return state.access === 'full';
}
