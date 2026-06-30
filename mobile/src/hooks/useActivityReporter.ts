import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Location from 'expo-location';
import Constants from 'expo-constants';
import { reportActivity, type ActivityLocation } from '@agent/shared';

/**
 * 获取当前位置（静默，不弹窗——权限由首次 foreground 时请求）
 */
async function getCurrentLocation(): Promise<ActivityLocation | undefined> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') return undefined;
    const loc = await Location.getLastKnownPositionAsync();
    if (loc) return { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
    const fresh = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { latitude: fresh.coords.latitude, longitude: fresh.coords.longitude };
  } catch {
    return undefined;
  }
}

/** 首次是否已请求过定位权限 */
let permissionRequested = false;

/**
 * 监听 AppState 变化，上报 app_foreground / app_background 事件。
 * foreground 事件附带 GPS 定位（首次进入时请求权限，后续静默读取）。
 */
export function useActivityReporter() {
  useEffect(() => {
    const reportForeground = async () => {
      // 首次进入前台时请求定位权限（仅一次）
      if (!permissionRequested) {
        permissionRequested = true;
        await Location.requestForegroundPermissionsAsync();
      }
      const location = await getCurrentLocation();
      reportActivity('app_foreground', { location, detail: `v${Constants.expoConfig?.version ?? '?'}` });
    };

    const handler = (next: AppStateStatus) => {
      if (next === 'active') {
        void reportForeground();
      } else if (next === 'background') {
        reportActivity('app_background');
      }
    };

    const sub = AppState.addEventListener('change', handler);
    // 初次进入上报
    void reportForeground();
    return () => sub.remove();
  }, []);
}
