/** M20-04 client-owned account/session boundary identity kernel. Pure and platform agnostic. */
export interface AuthPrincipal {
  userId: string;
  tenantId: string;
}

export interface BoundaryIdentity extends AuthPrincipal {
  generation: number;
}

export interface IdentityState {
  /** Monotonic client-owned generation; the server must never supply it. */
  generation: number;
  identity: BoundaryIdentity | null;
}

export type IdentityEvent =
  | { type: 'authenticated'; principal: AuthPrincipal }
  | { type: 'principal-switched'; principal: AuthPrincipal }
  | { type: 'tenant-switched'; principal: AuthPrincipal }
  | { type: 'logout' }
  | { type: 'token-invalidated' };

export const INITIAL_IDENTITY_STATE: IdentityState = Object.freeze({ generation: 0, identity: null });

export function samePrincipal(a: AuthPrincipal | null | undefined, b: AuthPrincipal | null | undefined): boolean {
  return !!a && !!b && a.userId === b.userId && a.tenantId === b.tenantId;
}

export function identityReducer(state: IdentityState, event: IdentityEvent): IdentityState {
  if (event.type === 'logout' || event.type === 'token-invalidated') {
    const generation = state.generation + 1;
    return { generation, identity: null };
  }
  if (samePrincipal(state.identity, event.principal)) return state;
  const generation = state.generation + 1;
  return { generation, identity: { ...event.principal, generation } };
}

export function selectIdentity(state: IdentityState): BoundaryIdentity | null {
  return state.identity;
}

export function selectPrincipal(state: IdentityState): AuthPrincipal | null {
  return state.identity ? { userId: state.identity.userId, tenantId: state.identity.tenantId } : null;
}

export function selectGeneration(state: IdentityState): number {
  return state.generation;
}

export function identityScope(identity: BoundaryIdentity): string {
  return `u=${encodeURIComponent(identity.userId)};t=${encodeURIComponent(identity.tenantId)};g=${identity.generation}`;
}

/** Sensitive persistent keys are never valid without an installed authenticated identity. */
export function scopedSensitiveKey(baseKey: string, identity: BoundaryIdentity | null | undefined): string | null {
  return identity ? `${baseKey}::${identityScope(identity)}` : null;
}

export interface OwnedLegacyValue<T> {
  value: T;
  owner?: AuthPrincipal;
}

/** N-1 data migrates only when ownership is explicit; ownerless/foreign data fails closed. */
export function migrateOwnedLegacyValue<T>(legacy: OwnedLegacyValue<T>, identity: BoundaryIdentity | null): T | null {
  return identity && samePrincipal(legacy.owner, identity) ? legacy.value : null;
}
