import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCAL_LOCK_BACKGROUND_MS,
  INITIAL_LOCAL_APP_LOCK_STATE,
  canUseSensitiveTransport,
  localAppLockReducer,
} from './localAppLock';

const enabled = () => localAppLockReducer(INITIAL_LOCAL_APP_LOCK_STATE, { type: 'configure', enabled: true });

describe('M30-02 local app-lock state machine', () => {
  it('is opt-in and cold-start locks only an enabled policy', () => {
    expect(INITIAL_LOCAL_APP_LOCK_STATE.access).toBe('full');
    expect(enabled().access).toBe('locked');
  });

  it('locks after the background threshold, but not before it', () => {
    const bg = localAppLockReducer(enabled(), { type: 'background', now: 100 });
    expect(localAppLockReducer(bg, { type: 'foreground', now: 100 + DEFAULT_LOCAL_LOCK_BACKGROUND_MS - 1 }).access).toBe('locked');
    const unlocked = { ...bg, access: 'full' as const };
    expect(localAppLockReducer(unlocked, { type: 'foreground', now: 100 + DEFAULT_LOCAL_LOCK_BACKGROUND_MS - 1 }).access).toBe('full');
    expect(localAppLockReducer(unlocked, { type: 'foreground', now: 100 + DEFAULT_LOCAL_LOCK_BACKGROUND_MS }).access).toBe('locked');
  });

  it('suppresses a short native system prompt transition', () => {
    const unlocked = { ...enabled(), access: 'full' as const };
    const bg = localAppLockReducer(unlocked, { type: 'background', now: 100, systemPrompt: true });
    expect(localAppLockReducer(bg, { type: 'foreground', now: 200 }).access).toBe('full');
  });

  it('admits only one prompt', () => {
    const first = localAppLockReducer(enabled(), { type: 'prompt-start', now: 1 });
    expect(first.promptInFlight).toBe(true);
    expect(localAppLockReducer(first, { type: 'prompt-start', now: 2 })).toBe(first);
  });

  it.each(['cancelled', 'failed', 'lockout'] as const)('keeps locked after %s and exposes fallback reason', (reason) => {
    const prompting = localAppLockReducer(enabled(), { type: 'prompt-start', now: 1 });
    const result = localAppLockReducer(prompting, { type: 'prompt-failure', reason });
    expect(result).toMatchObject({ access: 'locked', promptInFlight: false, failure: reason });
  });

  it('requires a valid server session for full access', () => {
    const prompting = localAppLockReducer(enabled(), { type: 'prompt-start', now: 1 });
    expect(localAppLockReducer(prompting, { type: 'prompt-success', serverSessionValid: true, offline: false }).access).toBe('full');
    expect(localAppLockReducer(prompting, { type: 'prompt-success', serverSessionValid: false, offline: false }).access).toBe('locked');
  });

  it('allows an offline shell but blocks sensitive transport', () => {
    const prompting = localAppLockReducer(enabled(), { type: 'prompt-start', now: 1 });
    const state = localAppLockReducer(prompting, { type: 'prompt-success', serverSessionValid: false, offline: true });
    expect(state.access).toBe('offline-shell');
    expect(canUseSensitiveTransport(state)).toBe(false);
  });

  it('clears policy and unlock state at every identity boundary', () => {
    const unlocked = { ...enabled(), access: 'full' as const };
    expect(localAppLockReducer(unlocked, { type: 'identity-boundary' })).toEqual(INITIAL_LOCAL_APP_LOCK_STATE);
  });
});
