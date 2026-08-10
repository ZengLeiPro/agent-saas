import { useMemo } from 'react';

import { evaluateAccess } from '../../../shared/src/lib/governanceApi';
import type { GovernanceCommand } from '../../../shared/src/lib/governanceApi';
import type { EffectiveResourceView } from '@agent/shared/types/governance';

import { useGovernanceRequest, type GovernanceRequestState } from './useGovernanceRequest';

export function useAccessEvaluation(
  command: GovernanceCommand | null,
): GovernanceRequestState<EffectiveResourceView[]> {
  const requestKey = command === null ? 'disabled' : JSON.stringify(command);
  const request = useMemo(
    () => command === null ? null : () => evaluateAccess(command),
    [requestKey],
  );
  return useGovernanceRequest(request, requestKey);
}
