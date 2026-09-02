import { describe, expect, it } from 'vitest';
import { adaptMobileLifecycle, mobileAppState, mobileReachability } from './lifecycleAdapter';

const rest = {
  authGeneration: 1, authEpoch: 1, appProtocolVersion: 50, schemaVersion: 5,
  wsState: 'disconnected' as const, queueHydrated: false, runtimeAttached: false, activeRun: false,
  recording: false, ttsPlaying: false, nonEssentialUploadActive: false, nowMs: 1,
};

describe('M50-05 Mobile lifecycle adapter parity', () => {
  it('uses only isInternetReachable and keeps null fail-closed', () => {
    expect(mobileReachability({ isInternetReachable: null })).toBeNull();
    expect(mobileReachability({ isInternetReachable: false })).toBe(false);
    expect(mobileReachability({ isInternetReachable: true })).toBe(true);
    const adapted = adaptMobileLifecycle({
      appState: 'active', networkGeneration: 4,
      netInfo: { isConnected: true, isInternetReachable: null, type: 'wifi' as never },
    }, rest);
    expect(adapted).toMatchObject({ isConnected: true, isInternetReachable: null, networkGeneration: 4, networkType: 'wifi' });
  });

  it('maps inactive/background without promising background residency', () => {
    expect(mobileAppState('active')).toBe('active');
    expect(mobileAppState('inactive')).toBe('inactive');
    expect(mobileAppState('background')).toBe('background');
    expect(mobileAppState('unknown')).toBe('inactive');
  });
});
