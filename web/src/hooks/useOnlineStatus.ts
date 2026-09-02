import { useState, useEffect } from 'react';
import { CANONICAL_REACHABILITY_EVENT } from '@/lib/lifecycleAdapter';

/** UI projection: online=true only after the canonical HTTP reachability probe succeeds. */
export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(false);

  useEffect(() => {
    const handleReachability = (event: Event) => {
      setIsOnline((event as CustomEvent<boolean>).detail === true);
    };
    const handleOffline = () => setIsOnline(false);
    window.addEventListener(CANONICAL_REACHABILITY_EVENT, handleReachability);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener(CANONICAL_REACHABILITY_EVENT, handleReachability);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}
