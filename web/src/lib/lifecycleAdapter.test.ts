import { describe, expect, it } from 'vitest';
import { adaptWebLifecycle, webReachability } from './lifecycleAdapter';

const rest = {
  authGeneration: 1, authEpoch: 1, appProtocolVersion: 50, schemaVersion: 5,
  wsState: 'disconnected' as const, queueHydrated: false, runtimeAttached: false, activeRun: false,
  recording: false, ttsPlaying: false, nonEssentialUploadActive: false, nowMs: 1,
};

describe('M50-05 Web thin lifecycle parity adapter', () => {
  it('keeps online=true unknown until the reachability probe succeeds', () => {
    expect(webReachability(true, null)).toBeNull();
    expect(webReachability(false, true)).toBe(false);
    expect(webReachability(true, true)).toBe(true);
  });

  it('maps visibility to the same canonical app state as Mobile', () => {
    expect(adaptWebLifecycle({ visibilityState: 'visible', online: true, networkGeneration: 2, effectiveType: '2g' }, true, rest))
      .toMatchObject({ appState: 'active', isInternetReachable: true, networkType: '2g' });
    expect(adaptWebLifecycle({ visibilityState: 'hidden', online: true, networkGeneration: 2 }, null, rest))
      .toMatchObject({ appState: 'background', isInternetReachable: null });
  });
});
