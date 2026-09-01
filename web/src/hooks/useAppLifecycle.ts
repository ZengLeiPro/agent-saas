import { useEffect, useRef, useCallback } from "react";
import { wsClient } from "@agent/shared";
import { CANONICAL_REACHABILITY_EVENT, webReachability } from "@/lib/lifecycleAdapter";

export interface AppLifecycleCallbacks {
  onResume: () => void;
  onSuspend: () => void;
}

const BACKGROUND_WS_GRACE_MS = 3_000;
const NETWORK_DEBOUNCE_MS = 750;

/** Thin Web visibility/online adapter for the shared M50-05 lifecycle contract. */
export function useAppLifecycle(callbacks: AppLifecycleCallbacks) {
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const generationRef = useRef(0);
  const detachedRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    closeTimerRef.current = null;
    reconnectTimerRef.current = null;
  }, []);

  const suspend = useCallback(() => {
    generationRef.current += 1;
    clearTimers();
    cbRef.current.onSuspend();
    if (wsClient.isConnected) detachedRef.current = wsClient.send({ action: 'detach' });
    wsClient.suspendNonEssentialTransport();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      if (document.visibilityState !== 'visible') wsClient.disconnect();
    }, BACKGROUND_WS_GRACE_MS);
  }, [clearTimers]);

  const recover = useCallback(async () => {
    generationRef.current += 1;
    const generation = generationRef.current;
    clearTimers();
    if (document.visibilityState !== 'visible' || webReachability(navigator.onLine, null) === false) return;
    try {
      // navigator.onLine=true is only a hint; a successful HTTP exchange is the reachability probe.
      await fetch('/api/health', { method: 'HEAD', cache: 'no-store' });
      window.dispatchEvent(new CustomEvent<boolean>(CANONICAL_REACHABILITY_EVENT, { detail: true }));
    } catch {
      window.dispatchEvent(new CustomEvent<boolean>(CANONICAL_REACHABILITY_EVENT, { detail: false }));
      return;
    }
    if (generation !== generationRef.current || document.visibilityState !== 'visible') return;
    wsClient.resumeNonEssentialTransport();
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (generation !== generationRef.current || document.visibilityState !== 'visible' || !navigator.onLine) return;
      if (detachedRef.current || !wsClient.isConnected) {
        detachedRef.current = false;
        void wsClient.forceReconnect().catch(() => {});
      }
      // Always restore authoritative queue/runtime/interaction state on foreground return.
      cbRef.current.onResume();
    }, NETWORK_DEBOUNCE_MS);
  }, [clearTimers]);

  const handleVisibilityChange = useCallback(() => {
    if (document.visibilityState === 'visible') void recover();
    else suspend();
  }, [recover, suspend]);

  const handlePageShow = useCallback((event: PageTransitionEvent) => {
    if (event.persisted) void recover();
  }, [recover]);

  useEffect(() => {
    const handleOnline = () => { if (document.visibilityState === 'visible') void recover(); };
    const handleOffline = () => {
      generationRef.current += 1;
      clearTimers();
      wsClient.suspendNonEssentialTransport();
      window.dispatchEvent(new CustomEvent<boolean>(CANONICAL_REACHABILITY_EVENT, { detail: false }));
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    if (document.visibilityState === 'visible') void recover();
    return () => {
      clearTimers();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [clearTimers, handlePageShow, handleVisibilityChange, recover]);
}
