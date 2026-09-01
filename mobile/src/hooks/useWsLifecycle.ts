import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { wsClient } from '@agent/shared';
import { mobileReachability } from '../platform/lifecycleAdapter';
import { telemetryClient } from '../telemetry/runtime';

const BACKGROUND_WS_GRACE_MS = 3_000;
const NETWORK_DEBOUNCE_MS = 750;

/**
 * Thin Mobile transport adapter. The shared lifecycle machine owns ordering; this adapter only
 * enforces immediate background suspension and strict NetInfo reachability on foreground resume.
 */
export function useWsLifecycle(enabled = true): void {
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const networkGenerationRef = useRef(0);
  const detachedRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const clearTimers = () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      closeTimerRef.current = null;
      reconnectTimerRef.current = null;
    };

    const suspend = () => {
      clearTimers();
      disconnectedAtRef.current = globalThis.performance?.now?.() ?? Date.now();
      telemetryClient()?.capture('ws_disconnect', { correlationId: 'ws-lifecycle', measurements: { foreground: false } });
      // Detach transport subscription only. The authoritative run is deliberately not aborted.
      if (wsClient.isConnected) detachedRef.current = wsClient.send({ action: 'detach' });
      wsClient.suspendNonEssentialTransport();
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        if (appStateRef.current !== 'active') wsClient.disconnect();
      }, BACKGROUND_WS_GRACE_MS);
    };

    const recover = async (generation: number) => {
      // NetInfo true is re-checked before and after the debounce window.
      const state = await NetInfo.fetch();
      if (generation !== networkGenerationRef.current || appStateRef.current !== 'active') return;
      if (mobileReachability(state) !== true || wsClient.isSendingFrozen) return;
      wsClient.resumeNonEssentialTransport();
      if (wsClient.isConnected && !detachedRef.current) return;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (generation !== networkGenerationRef.current || appStateRef.current !== 'active') return;
        void NetInfo.fetch().then((latest) => {
          if (generation === networkGenerationRef.current
            && appStateRef.current === 'active'
            && mobileReachability(latest) === true
            && !wsClient.isSendingFrozen
            && (!wsClient.isConnected || detachedRef.current)) {
            detachedRef.current = false;
            wsClient.resumeNonEssentialTransport();
            void wsClient.forceReconnect().then(() => {
              const disconnectedAt = disconnectedAtRef.current;
              disconnectedAtRef.current = null;
              telemetryClient()?.capture('ws_recovered', {
                correlationId: 'ws-lifecycle',
                ...(disconnectedAt !== null ? { measurements: { durationMs: Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - disconnectedAt) } } : {}),
              });
            }).catch(() => {});
          }
        });
      }, NETWORK_DEBOUNCE_MS);
    };

    const appSubscription = AppState.addEventListener('change', (next) => {
      appStateRef.current = next;
      networkGenerationRef.current += 1; // fences older fetch/debounce callbacks
      if (next !== 'active') suspend();
      else {
        clearTimers();
        void recover(networkGenerationRef.current);
      }
    });
    const networkSubscription = NetInfo.addEventListener((state) => {
      networkGenerationRef.current += 1;
      const generation = networkGenerationRef.current;
      if (appStateRef.current !== 'active' || mobileReachability(state) !== true) return;
      clearTimers();
      void recover(generation);
    });

    return () => {
      clearTimers();
      appSubscription.remove();
      networkSubscription();
    };
  }, [enabled]);
}
