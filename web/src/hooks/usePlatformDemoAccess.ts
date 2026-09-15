import { useCallback, useEffect, useState } from 'react';
import {
  PLATFORM_DEMO_BANNER,
  PLATFORM_DEMO_MENU_LABEL,
  fetchPlatformDemoAccess,
} from '@agent/shared/lib/platformDemoApi';

export interface PlatformDemoAccessState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  allowed: boolean;
  featureEnabled: boolean;
  banner: string;
  menuLabel: string;
  retry: () => void;
}

const CLOSED: Omit<PlatformDemoAccessState, 'retry'> = {
  status: 'idle',
  allowed: false,
  featureEnabled: true,
  banner: PLATFORM_DEMO_BANNER,
  menuLabel: PLATFORM_DEMO_MENU_LABEL,
};

export function usePlatformDemoAccess(options: {
  active: boolean;
  authEnabled: boolean;
  authLoading: boolean;
  userId?: string | null;
}): PlatformDemoAccessState {
  const [state, setState] = useState<Omit<PlatformDemoAccessState, 'retry'>>(CLOSED);
  const [sequence, setSequence] = useState(0);
  const retry = useCallback(() => setSequence((value) => value + 1), []);

  useEffect(() => {
    if (!options.active || options.authLoading) {
      setState(CLOSED);
      return;
    }
    if (!options.authEnabled || !options.userId) {
      setState({ ...CLOSED, status: 'ready' });
      return;
    }
    let current = true;
    setState((existing) => ({ ...existing, status: 'loading' }));
    void fetchPlatformDemoAccess()
      .then((response) => {
        if (!current) return;
        setState({
          status: 'ready',
          allowed: response.allowed === true,
          featureEnabled: response.featureEnabled !== false,
          banner: response.banner || PLATFORM_DEMO_BANNER,
          menuLabel: response.menuLabel || PLATFORM_DEMO_MENU_LABEL,
        });
      })
      .catch(() => {
        if (!current) return;
        setState({ ...CLOSED, status: 'error' });
      });
    return () => { current = false; };
  }, [options.active, options.authEnabled, options.authLoading, options.userId, sequence]);

  return { ...state, retry };
}
