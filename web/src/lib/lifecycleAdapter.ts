import type { CanonicalLifecycleInput, InternetReachability } from '@agent/shared';

export const CANONICAL_REACHABILITY_EVENT = 'agent:canonical-reachability';

/** Browser-only observation before canonical normalization. */
export interface WebLifecycleObservation {
  visibilityState: DocumentVisibilityState;
  online: boolean;
  networkGeneration: number;
  effectiveType?: string;
}

/** Thin Web parity adapter. navigator.onLine=false is authoritative offline; true still requires probe. */
export function webReachability(online: boolean, probeResult: InternetReachability): InternetReachability {
  if (!online) return false;
  return probeResult === true ? true : probeResult === false ? false : null;
}

export function adaptWebLifecycle(
  observation: WebLifecycleObservation,
  probeResult: InternetReachability,
  rest: Omit<CanonicalLifecycleInput, 'appState' | 'isConnected' | 'isInternetReachable' | 'networkGeneration' | 'networkType'>,
): CanonicalLifecycleInput {
  return {
    ...rest,
    appState: observation.visibilityState === 'visible' ? 'active' : 'background',
    isConnected: observation.online,
    isInternetReachable: webReachability(observation.online, probeResult),
    networkGeneration: observation.networkGeneration,
    networkType: observation.effectiveType ?? 'unknown',
  };
}
