import type { HandRecord } from '../runtime/handStore.js';

export function isTenantRemoteHand(hand: HandRecord): boolean {
  return (
    hand.type === 'server-remote' &&
    hand.status !== 'destroyed' &&
    typeof hand.metadata?.tenantRemoteHandId === 'string' &&
    hand.metadata.tenantRemoteHandId.length > 0
  );
}

export function selectCurrentTenantRemoteHand(
  hands: ReadonlyArray<HandRecord>,
): HandRecord | undefined {
  return (
    hands.find((hand) => hand.status === 'ready') ??
    hands.find((hand) => hand.status === 'provisioning') ??
    hands[0]
  );
}
