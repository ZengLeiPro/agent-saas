import { useEffect, useState, useRef } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { wsClient } from '@agent/shared';

export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(true);
  const prevOnline = useRef(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = state.isConnected !== false;
      setIsOnline(online);
      // offline -> online: force reconnect after a short delay for network stability
      if (online && !prevOnline.current && !wsClient.isConnected) {
        setTimeout(() => {
          if (!wsClient.isConnected) {
            wsClient.forceReconnect().catch(() => {});
          }
        }, 1000);
      }
      prevOnline.current = online;
    });
    return unsubscribe;
  }, []);

  return isOnline;
}
