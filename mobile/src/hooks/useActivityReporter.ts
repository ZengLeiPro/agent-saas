import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import Constants from 'expo-constants';
import { reportActivity } from '@agent/shared';

/**
 * Report lifecycle events without collecting device location. M10-05 removes
 * the former startup location request and every location field from mobile
 * activity reports; foreground/background reporting itself remains intact.
 */
export function useActivityReporter() {
  useEffect(() => {
    const reportForeground = () => {
      reportActivity('app_foreground', {
        detail: `v${Constants.expoConfig?.version ?? '?'}`,
      });
    };

    const handler = (next: AppStateStatus) => {
      if (next === 'active') {
        reportForeground();
      } else if (next === 'background') {
        reportActivity('app_background');
      }
    };

    const sub = AppState.addEventListener('change', handler);
    reportForeground();
    return () => sub.remove();
  }, []);
}
