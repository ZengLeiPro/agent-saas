import { describe, expect, it } from 'vitest';
import { reduceAutomationInFlight, type AutomationInFlightSummary } from './sessionAutomationInFlight.js';

const empty = (): AutomationInFlightSummary => ({
  activeRuns: 0, wakeups: 0, outbox: 0, executions: 0, evaluations: 0,
  providerAttempts: 0, interactions: 0, backgroundResources: 0,
  budgetReservations: 0, cancellations: 0, typedWork: 0, unknownOrDead: 0,
});

describe('reduceAutomationInFlight', () => {
  it.each(['evaluations', 'providerAttempts', 'backgroundResources', 'budgetReservations'] as const)(
    'keeps clear draining while %s is authoritative in-flight',
    key => expect(reduceAutomationInFlight('cancelled', { ...empty(), [key]: 1 })).toEqual({ kind: 'waiting' }),
  );

  it('finalizes only after the last authority closes', () => {
    expect(reduceAutomationInFlight('completed', { ...empty(), typedWork: 1 })).toEqual({ kind: 'waiting' });
    expect(reduceAutomationInFlight('completed', empty())).toEqual({ kind: 'terminal', status: 'completed' });
  });

  it('never projects a false terminal status for result_unknown/dead', () => {
    expect(reduceAutomationInFlight('failed', { ...empty(), unknownOrDead: 1 })).toEqual({ kind: 'reconcile_required' });
  });

  it('does not finalize without a durable desired terminal status', () => {
    expect(reduceAutomationInFlight(null, empty())).toEqual({ kind: 'waiting' });
  });
});
