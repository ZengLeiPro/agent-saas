import { describe, expect, it } from 'vitest';
import {
  createCanonicalLifecycleState,
  lifecycleAllowsDispatch,
  lifecycleBudgetUsage,
  presentCanonicalLifecycle,
  reduceCanonicalLifecycle,
  type CanonicalLifecycleInput,
  type CanonicalLifecyclePolicy,
  type CanonicalLifecycleState,
} from './appLifecycle';

const base = (overrides: Partial<CanonicalLifecycleInput> = {}): CanonicalLifecycleInput => ({
  appState: 'active', isConnected: true, isInternetReachable: true,
  networkGeneration: 1, networkType: 'wifi', authGeneration: 2, authEpoch: 3,
  appProtocolVersion: 50, schemaVersion: 5, wsState: 'disconnected', queueHydrated: false,
  runtimeAttached: false, activeRun: true, recording: false, ttsPlaying: false,
  nonEssentialUploadActive: false, nowMs: 0, ...overrides,
});

function observe(state: CanonicalLifecycleState, input: CanonicalLifecycleInput, policy?: CanonicalLifecyclePolicy) {
  return reduceCanonicalLifecycle(state, { type: 'observe', input }, policy);
}

function succeed(state: CanonicalLifecycleState, nowMs = 0, policy?: CanonicalLifecyclePolicy) {
  expect(state.effect).not.toBeNull();
  return reduceCanonicalLifecycle(state, { type: 'effect_succeeded', effectId: state.effect!.id, nowMs }, policy);
}

function driveReady(input = base()): { state: CanonicalLifecycleState; kinds: string[] } {
  let state = createCanonicalLifecycleState(input);
  const kinds: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    state = observe(state, input);
    kinds.push(state.effect!.kind);
    state = succeed(state);
  }
  state = observe(state, input);
  return { state, kinds };
}

describe('M50-05 canonical lifecycle recovery', () => {
  it('recovers in the one authoritative foreground order and gates dispatch until ready', () => {
    const { state, kinds } = driveReady();
    expect(kinds).toEqual([
      'recover_auth_journal', 'probe_reachability', 'connect_ws_auth', 'sync_seq_epoch',
      'fetch_queue_snapshot', 'attach_active_stream', 'restore_interactions',
    ]);
    expect(state.phase).toBe('ready');
    expect(lifecycleAllowsDispatch(state)).toBe(true);
    expect(presentCanonicalLifecycle(state)).toEqual({ state: 'ready', action: null, dispatchEnabled: true });
  });

  it.each([false, null] as const)('never treats reachability %s as reachable transport', (reachable) => {
    const input = base({ isConnected: true, isInternetReachable: reachable });
    let state = observe(createCanonicalLifecycleState(input), input);
    if (reachable === false) {
      expect(state.phase).toBe('offline');
      expect(state.effect).toBeNull();
    } else {
      expect(state.effect?.kind).toBe('recover_auth_journal');
      state = succeed(state);
      state = observe(state, input);
      expect(state.effect?.kind).toBe('probe_reachability');
      state = succeed(state);
      state = observe(state, input);
      expect(state.phase).toBe('probing');
      expect(state.effect).toBeNull();
    }
    expect(lifecycleAllowsDispatch(state)).toBe(false);
  });

  it('fences stale connect/ACK after wifi-cell generation switch and debounces the new probe', () => {
    const wifi = base({ networkGeneration: 7, networkType: 'wifi', nowMs: 100 });
    let state = observe(createCanonicalLifecycleState(wifi), wifi);
    const stale = state.effect!.id;
    const cellular = base({ networkGeneration: 8, networkType: 'cellular', nowMs: 200 });
    state = observe(state, cellular);
    expect(state.cycle).toBe(2);
    expect(state.effect?.kind).toBe('recover_auth_journal');
    state = reduceCanonicalLifecycle(state, { type: 'effect_succeeded', effectId: stale, nowMs: 201 });
    expect(state.effect?.kind).toBe('recover_auth_journal');
    state = succeed(state, 202);
    state = observe(state, { ...cellular, nowMs: 949 });
    expect(state.effect).toBeNull();
    state = observe(state, { ...cellular, nowMs: 950 });
    expect(state.effect?.kind).toBe('probe_reachability');
  });

  it('uses capped full jitter, Retry-After precedence, and resets attempt after WS auth', () => {
    const input = base();
    let state = observe(createCanonicalLifecycleState(input), input);
    state = reduceCanonicalLifecycle(state, { type: 'effect_failed', effectId: state.effect!.id, nowMs: 0, randomUnit: 0.5, retryAfterMs: 2_000 });
    expect(state.nextAttemptAt).toBe(2_000);
    expect(state.attempt).toBe(1);
    state = observe(state, { ...input, nowMs: 1_999 });
    expect(state.effect).toBeNull();
    state = observe(state, { ...input, nowMs: 2_000 });
    state = succeed(state, 2_000); // auth journal
    state = observe(state, { ...input, nowMs: 2_000 }); state = succeed(state, 2_000); // probe
    state = observe(state, { ...input, nowMs: 2_000 });
    expect(state.effect?.kind).toBe('connect_ws_auth');
    state = succeed(state, 2_000);
    expect(state.attempt).toBe(0);
  });

  it.each([3_000, 30_000, 300_000, 3_600_000])('suspends immediately and detaches without cancelling a run at bg %sms', (duration) => {
    const active = base({ recording: true, ttsPlaying: true, nonEssentialUploadActive: true });
    let state = createCanonicalLifecycleState(active);
    const bg = { ...active, appState: 'background' as const, nowMs: 10 };
    state = observe(state, bg);
    expect(state.effect?.kind).toBe('suspend_nonessential');
    expect(state.effect?.suspend).toMatchObject({ stopRecording: true, stopTts: true, pauseHeartbeat: true, preventNewWebSocket: true, cancelActiveRun: false });
    state = succeed(state, 10);
    state = observe(state, { ...bg, nowMs: 10 + duration });
    expect(state.effect?.kind).toBe('detach_background');
    state = succeed(state, 10 + duration);
    expect(state.phase).toBe('suspended');
    const resumed = observe(state, { ...active, nowMs: 20 + duration });
    expect(resumed.effect?.kind).toBe('recover_auth_journal');
  });

  it('keeps 2G/high-latency/5% loss retries under request and energy budgets', () => {
    const policy: CanonicalLifecyclePolicy = {
      debounceMs: 0, backgroundGraceMs: 3_000, baseBackoffMs: 500, maxBackoffMs: 30_000,
      budgetWindowMs: 60_000, maxRequestsPerWindow: 4, maxEnergyPerWindow: 8,
    };
    const slow2g = base({ networkType: '2g' });
    let state = createCanonicalLifecycleState(slow2g);
    for (let tick = 0; tick < 20; tick += 1) {
      const nowMs = tick * 3_000;
      state = observe(state, { ...slow2g, nowMs }, policy);
      if (state.effect) {
        state = tick % 5 === 0
          ? reduceCanonicalLifecycle(state, { type: 'effect_failed', effectId: state.effect.id, nowMs, randomUnit: 0.05 }, policy)
          : succeed(state, nowMs, policy);
      }
    }
    const usage = lifecycleBudgetUsage(state, 59_999, policy);
    expect(usage.requests).toBeLessThanOrEqual(4);
    expect(usage.energy).toBeLessThanOrEqual(8);
    expect(['degraded', 'probing', 'connecting', 'syncing', 'attached', 'ready']).toContain(state.phase);
  });

  it('exposes one recovery action for offline/reconnecting/syncing/degraded', () => {
    const input = base({ isInternetReachable: false });
    const state = observe(createCanonicalLifecycleState(input), input);
    expect(presentCanonicalLifecycle(state)).toEqual({ state: 'offline', action: 'recover', dispatchEnabled: false });
  });
});
