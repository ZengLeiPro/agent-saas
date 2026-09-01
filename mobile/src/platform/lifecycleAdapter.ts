import type { AppStateStatus } from 'react-native';
import type { NetInfoState } from '@react-native-community/netinfo';
import type {
  CanonicalAppState,
  CanonicalLifecycleInput,
  InternetReachability,
} from '@agent/shared';

export function mobileAppState(state: AppStateStatus): CanonicalAppState {
  return state === 'active' ? 'active' : state === 'background' ? 'background' : 'inactive';
}

/** NetInfo isConnected is diagnostic; only isInternetReachable drives recovery. */
export function mobileReachability(state: Pick<NetInfoState, 'isInternetReachable'>): InternetReachability {
  return state.isInternetReachable === true ? true
    : state.isInternetReachable === false ? false
    : null;
}

export interface MobileLifecycleObservation {
  appState: AppStateStatus;
  netInfo: Pick<NetInfoState, 'isConnected' | 'isInternetReachable' | 'type'>;
  networkGeneration: number;
}

export function adaptMobileLifecycle(
  observation: MobileLifecycleObservation,
  rest: Omit<CanonicalLifecycleInput, 'appState' | 'isConnected' | 'isInternetReachable' | 'networkGeneration' | 'networkType'>,
): CanonicalLifecycleInput {
  return {
    ...rest,
    appState: mobileAppState(observation.appState),
    isConnected: observation.netInfo.isConnected === true,
    isInternetReachable: mobileReachability(observation.netInfo),
    networkGeneration: observation.networkGeneration,
    networkType: observation.netInfo.type,
  };
}
