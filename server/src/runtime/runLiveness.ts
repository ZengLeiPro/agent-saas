import {
  RUN_LIVENESS_VERSION,
  type RunLiveness,
  type RunLivenessRecoveryAction,
  type RunLivenessState,
} from '@agent/shared';
import type { RunRecord, RunStatus } from './runStoreTypes.js';

export { RUN_LIVENESS_VERSION } from '@agent/shared';
export type { RunLiveness, RunLivenessRecoveryAction, RunLivenessState } from '@agent/shared';
export type RunHeartbeatSource = 'stream' | 'tool' | 'subagent' | 'worker';

export interface LivenessReapResult {
  stale: RunRecord[];
  orphaned: RunRecord[];
}

export function livenessStateForStatus(status: RunStatus): Exclude<RunLivenessState, 'unknown' | 'stale'> {
  if (status === 'orphaned') return 'orphaned';
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return 'terminal';
  if (status === 'waiting_approval' || status === 'waiting_user') return 'waiting_interaction';
  if (status === 'running' || status === 'waiting_hand') return 'busy';
  return 'active';
}

export function recoveryActionsForLiveness(
  state: RunLivenessState,
  reasonCode?: string,
): RunLivenessRecoveryAction[] {
  if (state === 'terminal' || state === 'unknown') return [];
  if (state === 'orphaned') {
    return reasonCode === 'external_tool_outcome_unknown' ? ['cancel'] : ['retry', 'cancel'];
  }
  if (state === 'stale') return ['cancel'];
  return ['cancel'];
}

/**
 * Normalizes persisted fields without guessing from updatedAt. Rows created before M40-02 have
 * no version and remain explicitly unknown, even if their legacy status looks active.
 */
export function projectRunLiveness(run: Pick<RunRecord,
  'status' | 'statusReason' | 'workerId' | 'leaseExpiresAt' | 'liveness'
>): RunLiveness {
  const persisted = run.liveness;
  if (!persisted || persisted.version < RUN_LIVENESS_VERSION) {
    return { state: 'unknown', recoveryActions: [], version: 0 };
  }
  const state = run.status === 'orphaned'
    ? 'orphaned'
    : run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
      ? 'terminal'
      : persisted.state;
  const terminal = state === 'terminal' || state === 'orphaned';
  const ownerId = terminal ? undefined : persisted.ownerId ?? run.workerId;
  const leaseExpiresAt = terminal ? undefined : persisted.leaseExpiresAt ?? run.leaseExpiresAt;
  const reasonCode = terminal ? run.statusReason ?? persisted.reasonCode : persisted.reasonCode;
  return {
    state,
    ...(persisted.lastHeartbeatAt ? { lastHeartbeatAt: persisted.lastHeartbeatAt } : {}),
    ...(leaseExpiresAt ? { leaseExpiresAt } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    recoveryActions: recoveryActionsForLiveness(state, reasonCode),
    ...(persisted.detectedAt ? { detectedAt: persisted.detectedAt } : {}),
    version: persisted.version,
  };
}
