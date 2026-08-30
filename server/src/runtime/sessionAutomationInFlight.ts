export type AutomationDesiredTerminalStatus = 'completed' | 'cancelled' | 'failed' | 'expired';

export interface AutomationInFlightSummary {
  activeRuns: number;
  wakeups: number;
  outbox: number;
  executions: number;
  evaluations: number;
  providerAttempts: number;
  interactions: number;
  backgroundResources: number;
  budgetReservations: number;
  cancellations: number;
  typedWork: number;
  unknownOrDead: number;
}

export type AutomationFinalizeDecision =
  | { kind: 'waiting' }
  | { kind: 'reconcile_required' }
  | { kind: 'terminal'; status: AutomationDesiredTerminalStatus };

/** Pure authority reducer. A terminal projection is legal only when every durable authority is closed. */
export function reduceAutomationInFlight(
  desired: AutomationDesiredTerminalStatus | null | undefined,
  summary: AutomationInFlightSummary,
): AutomationFinalizeDecision {
  if (!desired) return { kind: 'waiting' };
  if (summary.unknownOrDead > 0) return { kind: 'reconcile_required' };
  const open = summary.activeRuns + summary.wakeups + summary.outbox + summary.executions
    + summary.evaluations + summary.providerAttempts + summary.interactions
    + summary.backgroundResources + summary.budgetReservations + summary.cancellations
    + summary.typedWork;
  return open === 0 ? { kind: 'terminal', status: desired } : { kind: 'waiting' };
}
