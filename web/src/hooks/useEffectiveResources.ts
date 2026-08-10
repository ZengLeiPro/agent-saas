import { useMemo } from 'react';

import { fetchEffectiveResources } from '../../../shared/src/lib/governanceApi';
import type { EffectiveResourceView, GovernanceDomain } from '@agent/shared/types/governance';

import { useGovernanceRequest, type GovernanceRequestState } from './useGovernanceRequest';

export function useEffectiveResources(
  domains: GovernanceDomain[] = [],
): GovernanceRequestState<EffectiveResourceView[]> {
  const requestKey = domains.join(',');
  const request = useMemo(() => () => fetchEffectiveResources(domains), [requestKey]);
  return useGovernanceRequest(request, requestKey);
}
