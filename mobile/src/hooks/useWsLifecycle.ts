import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { wsClient } from '@agent/shared';

/** App 回到前台时，检测 WS 状态并强制重连 */
export function useWsLifecycle(): void {
    const backgroundAtRef = useRef(0);
    const lastReconnectAtRef = useRef(0);

    useEffect(() => {
        const handler = (next: AppStateStatus) => {
            if (next === 'background' || next === 'inactive') {
                backgroundAtRef.current ||= Date.now();
            } else if (next === 'active' && backgroundAtRef.current > 0) {
                const elapsed = Date.now() - backgroundAtRef.current;
                backgroundAtRef.current = 0;
                const sinceLast = Date.now() - lastReconnectAtRef.current;
                if (sinceLast < 2000) return;
                if (elapsed > 3_000 || !wsClient.isConnected) {
                    lastReconnectAtRef.current = Date.now();
                    wsClient.forceReconnect().catch(() => {});
                }
            }
        };
        const sub = AppState.addEventListener('change', handler);
        return () => sub.remove();
    }, []);
}
