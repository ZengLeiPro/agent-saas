import { useEffect, useState } from 'react';

/** Startup-safe: only returns whether platform-demo entry is allowed; fetches via dynamic import. */
export function usePlatformDemoEntryAllowed(options: {
  active: boolean;
  authEnabled: boolean;
  authLoading: boolean;
  userId?: string | null;
}): boolean {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (!options.active || options.authLoading || !options.authEnabled || !options.userId) {
      setAllowed(false);
      return;
    }
    let current = true;
    void import('@agent/shared/lib/platformDemoApi')
      .then(({ fetchPlatformDemoAccess }) => fetchPlatformDemoAccess())
      .then((response) => {
        if (current) setAllowed(response.allowed === true);
      })
      .catch(() => {
        if (current) setAllowed(false);
      });
    return () => {
      current = false;
    };
  }, [options.active, options.authEnabled, options.authLoading, options.userId]);

  return allowed;
}
