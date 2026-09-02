import {
  selectRunLivenessPresentation,
  selectRunLivenessRecovery,
  type RunLiveness,
  type RunRecoveryGate,
} from '@agent/shared';

export type WebRunLivenessTone = 'neutral' | 'active' | 'warning' | 'danger' | 'terminal';

/** Thin Web adapter: wording and recovery authority remain in shared/server contracts. */
export function adaptWebRunLiveness(liveness: RunLiveness | undefined, gate: RunRecoveryGate) {
  const presentation = selectRunLivenessPresentation(liveness);
  const recovery = selectRunLivenessRecovery(liveness, gate);
  const tone: WebRunLivenessTone = presentation.running
    ? 'active'
    : presentation.state === 'stale'
      ? 'warning'
      : presentation.state === 'orphaned'
        ? 'danger'
        : presentation.terminal
          ? 'terminal'
          : 'neutral';
  return { ...presentation, tone, recovery };
}
