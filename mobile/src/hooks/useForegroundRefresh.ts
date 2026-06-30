import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useAuth } from '../contexts/AuthContext';

/**
 * Refresh user settings from server when app returns to foreground.
 * Centralized here to avoid duplicate /api/auth/me requests from multiple hooks.
 */
export function useForegroundRefresh(): void {
  const { user, refreshUser } = useAuth();

  useEffect(() => {
    if (!user?.id) return;

    const handler = (state: AppStateStatus) => {
      if (state === 'active') {
        void refreshUser();
      }
    };
    const sub = AppState.addEventListener('change', handler);
    return () => sub.remove();
  }, [user?.id, refreshUser]);
}
