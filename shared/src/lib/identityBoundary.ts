import { identityReducer, type BoundaryIdentity, type IdentityEvent, type IdentityState } from './identity';

export interface IdentityBoundaryHooks {
  freezeSending(): void | Promise<void>;
  disconnectRealtime(): void | Promise<void>;
  clearRecovery(): void | Promise<void>;
  clearSensitiveState(): void | Promise<void>;
  installIdentity(identity: BoundaryIdentity | null): void | Promise<void>;
  reconnectAndHydrate?(identity: BoundaryIdentity): void | Promise<void>;
}

/**
 * One serialized boundary transaction. Ordering is security-significant:
 * freeze -> disconnect -> clear cursor/projections/persistence -> install -> authoritative hydrate.
 */
export async function runIdentityBoundary(
  state: IdentityState,
  event: IdentityEvent,
  hooks: IdentityBoundaryHooks,
): Promise<IdentityState> {
  await hooks.freezeSending();
  await hooks.disconnectRealtime();
  await hooks.clearRecovery();
  await hooks.clearSensitiveState();
  const next = identityReducer(state, event);
  await hooks.installIdentity(next.identity);
  if (next.identity && hooks.reconnectAndHydrate) await hooks.reconnectAndHydrate(next.identity);
  return next;
}
