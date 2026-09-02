import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { mobileReachability } from '../platform/lifecycleAdapter';

/** Presentation-only reachability. Canonical lifecycle owns reconnect effects. */
export function useOnlineStatus(): boolean {
  // Unknown/null is fail-closed and must not flash as online before NetInfo resolves.
  const [isOnline, setIsOnline] = useState(false);

  useEffect(() => NetInfo.addEventListener((state) => {
    setIsOnline(mobileReachability(state) === true);
  }), []);

  return isOnline;
}
