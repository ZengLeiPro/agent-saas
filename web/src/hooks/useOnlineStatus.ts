import { useState, useEffect } from 'react';
import { CANONICAL_REACHABILITY_EVENT } from '@/lib/lifecycleAdapter';
import { apiUrl } from '@/lib/apiBase';

/**
 * `null` means reachability has not been verified yet. Keep that distinct from a
 * confirmed offline result so a fresh page does not render a false warning.
 */
export type OnlineStatus = boolean | null;

export function initialOnlineStatus(onlineHint: boolean): OnlineStatus {
  return onlineHint ? null : false;
}

let initialReachabilityProbe: Promise<boolean> | null = null;

/** StrictMode-safe singleflight for the initial UI reachability projection. */
function probeInitialReachability(): Promise<boolean> {
  if (!initialReachabilityProbe) {
    const request = fetch(apiUrl('/api/health'), { method: 'HEAD', cache: 'no-store' })
      .then(() => true, () => false)
      .finally(() => {
        if (initialReachabilityProbe === request) initialReachabilityProbe = null;
      });
    initialReachabilityProbe = request;
  }
  return initialReachabilityProbe;
}

export function useOnlineStatus(): OnlineStatus {
  const [isOnline, setIsOnline] = useState<OnlineStatus>(() => initialOnlineStatus(navigator.onLine));

  useEffect(() => {
    let active = true;
    let initialProbeSuperseded = false;
    const handleReachability = (event: Event) => {
      initialProbeSuperseded = true;
      setIsOnline((event as CustomEvent<boolean>).detail === true);
    };
    const handleOffline = () => {
      initialProbeSuperseded = true;
      setIsOnline(false);
    };
    window.addEventListener(CANONICAL_REACHABILITY_EVENT, handleReachability);
    window.addEventListener('offline', handleOffline);
    if (navigator.onLine) {
      void probeInitialReachability().then((reachable) => {
        if (active && !initialProbeSuperseded) setIsOnline(navigator.onLine ? reachable : false);
      });
    }
    return () => {
      active = false;
      window.removeEventListener(CANONICAL_REACHABILITY_EVENT, handleReachability);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}
