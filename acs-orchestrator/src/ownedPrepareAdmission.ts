import { OwnershipBlockedError, type OwnershipRecord } from './ownershipState.js';
import { OwnedWaitEndedError } from './ownedWait.js';

/** Admission identity is the normalized sandbox name plus mount, not the raw ensure body. */
export function ensureAdmissionFingerprint(ref: { name: string; mountSubPath: string }): string {
  return `${ref.name}\0${ref.mountSubPath}`;
}

/**
 * A timed-out CAS may have committed. Never discard its local owner.
 * A deterministic reserve conflict that never reached the journal must not
 * call complete()/update — those persist paths would mark persistence_unknown.
 */
export async function settleBeginReservationFailure(
  registry: { compact(): void },
  operation: {
    durable: boolean;
    record: OwnershipRecord;
    canProveNeverDispatched(): boolean;
    markUncertain(reasonCode: string): void;
  },
  error: unknown,
): Promise<void> {
  const mayHaveCommitted = error instanceof OwnedWaitEndedError || operation.durable;
  if (
    !mayHaveCommitted &&
    operation.canProveNeverDispatched() &&
    error instanceof OwnershipBlockedError
  ) {
    operation.record = {
      ...operation.record,
      resource: 'not_started',
      outcome: 'failed',
      phase: 'not_started',
      reasonCode: 'reservation_rejected',
      phaseDeadlineAt: undefined,
    };
    registry.compact();
    return;
  }
  operation.markUncertain('reservation_unknown');
}
