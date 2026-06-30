import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * Calls `onResume` when app returns to foreground after being
 * in background for at least `minBackgroundMs` (default 30s).
 */
export function useAppLifecycle(onResume: () => void, minBackgroundMs = 30_000) {
  const wentBackgroundAt = useRef<number | null>(null);
  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;

  useEffect(() => {
    const handler = (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        wentBackgroundAt.current = Date.now();
      } else if (next === 'active') {
        const t = wentBackgroundAt.current;
        wentBackgroundAt.current = null;
        if (t && Date.now() - t >= minBackgroundMs) {
          onResumeRef.current();
        }
      }
    };

    const sub = AppState.addEventListener('change', handler);
    return () => sub.remove();
  }, [minBackgroundMs]);
}
