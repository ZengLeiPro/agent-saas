import { describe, expect, it, vi } from 'vitest';
import { createCanonicalLifecycleState, reduceCanonicalLifecycle, type CanonicalLifecycleInput } from './appLifecycle';
import { executeCanonicalLifecycleEffect, type CanonicalLifecycleEffectDependencies } from './appLifecycleEffects';

const input: CanonicalLifecycleInput = {
  appState: 'active', isConnected: true, isInternetReachable: true, networkGeneration: 8,
  networkType: 'cellular', authGeneration: 2, authEpoch: 3, appProtocolVersion: 50, schemaVersion: 5,
  wsState: 'connected', queueHydrated: false, runtimeAttached: false, activeRun: true,
  recording: false, ttsPlaying: false, nonEssentialUploadActive: false, nowMs: 0,
};

const deps = (): CanonicalLifecycleEffectDependencies => ({
  recoverAuthJournal: vi.fn(), probeReachability: vi.fn(() => true), connectWsAuth: vi.fn(),
  sendWs: vi.fn(() => true), syncCursor: vi.fn(() => ({ lastSeq: 4, epoch: 'server-2', sessionId: 's' })),
  activeSession: vi.fn(() => ({ sessionId: 's', lastEventId: 7, lastEventCursor: 'cursor-7' })),
  restoreInteractions: vi.fn(), stopRecording: vi.fn(), stopTts: vi.fn(), pauseNonEssentialUploads: vi.fn(),
  pauseHeartbeatAndPolling: vi.fn(), closeWs: vi.fn(),
});

function effectAtStep(target: string) {
  let state = createCanonicalLifecycleState(input);
  for (;;) {
    state = reduceCanonicalLifecycle(state, { type: 'observe', input });
    if (state.effect?.kind === target) return state.effect;
    state = reduceCanonicalLifecycle(state, { type: 'effect_succeeded', effectId: state.effect!.id, nowMs: 0 });
  }
}

describe('M50-05 lifecycle effect adapter', () => {
  it.each([
    ['sync_seq_epoch', 'sync'],
    ['fetch_queue_snapshot', 'queue_snapshot'],
    ['attach_active_stream', 'attach_active_stream'],
  ] as const)('sends %s with idempotent requestId and network fence', async (kind, action) => {
    const dependencies = deps();
    const effect = effectAtStep(kind);
    expect(await executeCanonicalLifecycleEffect(effect, dependencies)).toMatchObject({ succeeded: true });
    expect(dependencies.sendWs).toHaveBeenCalledWith(expect.objectContaining({
      action, requestId: effect.requestId, networkGeneration: 8,
    }));
  });

  it('stops recorder/TTS/uploads and pauses heartbeat without aborting the run', async () => {
    let state = createCanonicalLifecycleState(input);
    state = reduceCanonicalLifecycle(state, { type: 'observe', input: { ...input, appState: 'background', nowMs: 1 } });
    const dependencies = deps();
    await executeCanonicalLifecycleEffect(state.effect!, dependencies);
    expect(dependencies.stopRecording).toHaveBeenCalledOnce();
    expect(dependencies.stopTts).toHaveBeenCalledOnce();
    expect(dependencies.pauseNonEssentialUploads).toHaveBeenCalledOnce();
    expect(dependencies.pauseHeartbeatAndPolling).toHaveBeenCalledOnce();
    expect(dependencies.sendWs).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'abort' }));
  });
});
