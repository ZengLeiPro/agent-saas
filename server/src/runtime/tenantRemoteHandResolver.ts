import type { HandRecord } from './handStore.js';
import type { SecretVault } from '../security/secretVault.js';
import type { TenantRemoteHandDispatchConfig } from './rawRuntimeRunDispatch.js';

/**
 * B1: Should the runtime attach `hand` for the requesting user/session?
 *
 * Allow-list semantics — independently permissive:
 *   - Neither `users` nor `tenantIds` declared → attach for everyone.
 *   - Only `users` declared → require username match.
 *   - Only `tenantIds` declared → require userTenantId match.
 *   - Both declared → attach if EITHER list matches (union).
 *
 * Returns `false` when there is no requesting user identity (caller decides to
 * skip attaching for anonymous / system sessions).
 */
export function evaluateTenantHandAttachPolicy(
  hand: Pick<TenantRemoteHandDispatchConfig, 'rollout' | 'users' | 'tenantIds'>,
  identity: { userId?: string; username?: string; userTenantId?: string },
): boolean {
  if (!identity.userId && !identity.username) return false;
  if (hand.rollout) {
    switch (hand.rollout.mode) {
      case 'disabled':
      case 'drain':
        return false;
      case 'all':
        return true;
      case 'allowlist':
        return (
          (!!identity.userId && !!hand.rollout.userIds?.includes(identity.userId)) ||
          (!!identity.username && !!hand.rollout.usernames?.includes(identity.username))
        );
      case 'tenant':
        return !!identity.userTenantId && !!hand.rollout.tenantIds?.includes(identity.userTenantId);
    }
  }
  const declaresUsers = !!hand.users?.length;
  const declaresTenants = !!hand.tenantIds?.length;
  if (!declaresUsers && !declaresTenants) return true;
  const userMatches = declaresUsers && !!identity.username && hand.users!.includes(identity.username);
  const tenantMatches = declaresTenants && !!identity.userTenantId && hand.tenantIds!.includes(identity.userTenantId);
  return userMatches || tenantMatches;
}

export function selectTenantRemoteHandsForRegistration<T extends Pick<TenantRemoteHandDispatchConfig, 'rollout' | 'users' | 'tenantIds'>>(
  hands: T[] | undefined,
  identity: { userId?: string; username?: string; userTenantId?: string },
): T[] {
  return (hands ?? []).filter((hand) => evaluateTenantHandAttachPolicy(hand, identity));
}

export interface TenantRemoteHandResolverLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface TenantRemoteHandResolverDeps {
  /** Static tenant remote hand entries from app config. */
  tenantRemoteHands?: TenantRemoteHandDispatchConfig[] | (() => TenantRemoteHandDispatchConfig[] | undefined);
  /** SecretVault used when an entry declares `authTokenRef`. */
  vault?: SecretVault;
  logger?: TenantRemoteHandResolverLogger;
}

export interface ResolvedTenantRemoteHand {
  id: string;
  baseUrl: string;
  authToken: string;
  invokeTimeoutMs?: number;
  /** Present only when the token came from a vault ref; metadata-only marker for ops/audit. */
  authTokenRef?: string;
  source: 'inline' | 'vault';
}

export interface TenantRemoteHandAuthTokenResolver {
  /**
   * Look up the bearer token for a registered hand record at dispatch / cancel
   * delivery time. Returns undefined when the hand isn't a tenant remote hand
   * (no `metadata.tenantRemoteHandId`) or no matching config entry exists.
   * Throws when an entry declares `authTokenRef` but no vault is available, or
   * when the vault rejects the lookup.
   */
  resolveForHand(hand: HandRecord): Promise<string | undefined>;
  /**
   * Resolve a config entry at register time, returning the plaintext token plus
   * audit metadata for the HandStore record. Plaintext is held only in the
   * caller's transport ctor closure; the returned `authTokenRef` is meant to
   * land in HandStore metadata so cancel-delivery / ops tooling can trace
   * which vault ref produced the credential.
   */
  resolveForRegister(entry: TenantRemoteHandDispatchConfig): Promise<ResolvedTenantRemoteHand>;
}

const VAULT_CALLER = {
  actor: 'system' as const,
  userId: '__system__',
  scopes: ['secret:tenant_hand:read'],
};

function findEntryById(
  entries: TenantRemoteHandDispatchConfig[] | undefined,
  id: string,
): TenantRemoteHandDispatchConfig | undefined {
  return entries?.find((candidate) => candidate.id === id);
}

function resolveEntries(
  entries: TenantRemoteHandResolverDeps['tenantRemoteHands'],
): TenantRemoteHandDispatchConfig[] | undefined {
  return typeof entries === 'function' ? entries() : entries;
}

async function resolveEntry(
  entry: TenantRemoteHandDispatchConfig,
  deps: TenantRemoteHandResolverDeps,
): Promise<ResolvedTenantRemoteHand> {
  if (entry.authTokenRef) {
    if (!deps.vault) {
      throw new Error(
        `tenant remote hand "${entry.id}" declares authTokenRef but no SecretVault is configured`,
      );
    }
    const authToken = await deps.vault.getSecret(entry.authTokenRef, VAULT_CALLER);
    return {
      id: entry.id,
      baseUrl: entry.baseUrl,
      authToken,
      ...(entry.invokeTimeoutMs ? { invokeTimeoutMs: entry.invokeTimeoutMs } : {}),
      authTokenRef: entry.authTokenRef,
      source: 'vault',
    };
  }
  if (entry.authToken) {
    return {
      id: entry.id,
      baseUrl: entry.baseUrl,
      authToken: entry.authToken,
      ...(entry.invokeTimeoutMs ? { invokeTimeoutMs: entry.invokeTimeoutMs } : {}),
      source: 'inline',
    };
  }
  // Schema enforces oneOf at config load, so reaching here means caller built
  // an entry programmatically without either field.
  throw new Error(`tenant remote hand "${entry.id}" has neither authToken nor authTokenRef`);
}

export function createTenantRemoteHandAuthTokenResolver(
  deps: TenantRemoteHandResolverDeps,
): TenantRemoteHandAuthTokenResolver {
  return {
    async resolveForHand(hand: HandRecord): Promise<string | undefined> {
      const id = typeof hand.metadata.tenantRemoteHandId === 'string'
        ? hand.metadata.tenantRemoteHandId
        : undefined;
      if (!id) return undefined;
      const entry = findEntryById(resolveEntries(deps.tenantRemoteHands), id);
      if (!entry) return undefined;
      const resolved = await resolveEntry(entry, deps);
      return resolved.authToken;
    },
    async resolveForRegister(entry: TenantRemoteHandDispatchConfig): Promise<ResolvedTenantRemoteHand> {
      return resolveEntry(entry, deps);
    },
  };
}
