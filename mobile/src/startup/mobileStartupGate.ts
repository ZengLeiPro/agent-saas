import {
  capabilityAllowed,
  evaluateMobileCompatibility,
  type DurablePendingSubmission,
  type MobileCapability,
  type MobileCompatibilityClientIdentity,
  type MobileCompatibilityDecision,
  type PendingRecoveryDecision,
  type SignedMobileCompatibilityPolicy,
} from '@agent/shared';

export type StartupTokenState = 'valid' | 'expired' | 'revoked' | 'anonymous';
export type MobileStartupResult =
  | { state: 'ready'; decision: MobileCompatibilityDecision; pending: readonly PendingRecoveryDecision[] }
  | { state: 'auth_required'; reason: 'expired' | 'revoked' | 'anonymous'; safeActions: readonly ['login']; localDataPreserved: true }
  | { state: 'blocked'; decision: Extract<MobileCompatibilityDecision, { status: 'blocked' }>; safeActions: readonly ['logout', 'update']; localDataPreserved: true };

export interface MobileStartupDependencies {
  resumeAuthLifecycle(): Promise<StartupTokenState>;
  migrateCacheV1ToV2(): Promise<void>;
  fetchAndVerifyCompatibilityPolicy(): Promise<SignedMobileCompatibilityPolicy>;
  currentClient: MobileCompatibilityClientIdentity;
  recoverOldPending(): Promise<readonly PendingRecoveryDecision[]>;
  handleInvalidTokenTransaction(reason: 'expired' | 'revoked'): Promise<void>;
  connect(): Promise<void>;
  enableSend(): void;
  now?(): number;
}

/**
 * M70-02 startup fence. Transport and send remain disabled until auth recovery, cache migration,
 * signed compatibility policy, and pending classification have all completed.
 */
export async function runMobileStartupGate(deps: MobileStartupDependencies): Promise<MobileStartupResult> {
  const token = await deps.resumeAuthLifecycle();
  if (token === 'expired' || token === 'revoked') {
    // Invalid credentials are fenced by the existing M30 transaction before any policy fetch.
    await deps.handleInvalidTokenTransaction(token);
    return { state: 'auth_required', reason: token, safeActions: ['login'], localDataPreserved: true };
  }
  if (token === 'anonymous') return { state: 'auth_required', reason: token, safeActions: ['login'], localDataPreserved: true };
  await deps.migrateCacheV1ToV2();
  const policy = await deps.fetchAndVerifyCompatibilityPolicy();
  const decision = evaluateMobileCompatibility(policy, deps.currentClient, deps.now?.() ?? Date.now());
  const pending = await deps.recoverOldPending();
  if (pending.some((item) => item.autoReplay !== false)) throw new Error('PENDING_AUTO_REPLAY_FORBIDDEN');
  if (decision.status === 'blocked') {
    return { state: 'blocked', decision, safeActions: ['logout', 'update'], localDataPreserved: true };
  }
  await deps.connect();
  deps.enableSend();
  return { state: 'ready', decision, pending };
}

export function authorizeMobileAction(decision: MobileCompatibilityDecision, capability: MobileCapability): { allowed: boolean; reason?: string } {
  if (decision.status === 'blocked') return { allowed: false, reason: decision.reason };
  return capabilityAllowed(decision, capability) ? { allowed: true } : { allowed: false, reason: `capability_disabled:${capability}` };
}

/** Rollout, rollback and hotfix must classify durable pending; they never replay payloads. */
export function assertNoPendingReplay(pending: readonly Pick<DurablePendingSubmission, 'clientMsgId'>[], decisions: readonly PendingRecoveryDecision[]): void {
  if (pending.length !== decisions.length || decisions.some((item) => item.autoReplay !== false)) throw new Error('PENDING_AUTO_REPLAY_FORBIDDEN');
}
