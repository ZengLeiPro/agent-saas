import {
  selectRunLivenessPresentation,
  selectRunLivenessRecovery,
  type RunLiveness,
  type RunRecoveryGate,
} from '@agent/shared';

export type MobileRunLivenessEmphasis = 'muted' | 'progress' | 'attention' | 'critical' | 'settled';

/** Thin Mobile adapter: no timers, dispatch, retry policy, or lifecycle inference. */
export function adaptMobileRunLiveness(liveness: RunLiveness | undefined, gate: RunRecoveryGate) {
  const presentation = selectRunLivenessPresentation(liveness);
  const recovery = selectRunLivenessRecovery(liveness, gate);
  const emphasis: MobileRunLivenessEmphasis = presentation.running
    ? 'progress'
    : presentation.state === 'stale'
      ? 'attention'
      : presentation.state === 'orphaned'
        ? 'critical'
        : presentation.terminal
          ? 'settled'
          : 'muted';
  return {
    ...presentation,
    emphasis,
    accessibilityLabel: presentation.label,
    recovery,
  };
}
