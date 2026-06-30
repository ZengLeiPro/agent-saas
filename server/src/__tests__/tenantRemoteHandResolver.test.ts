import { describe, expect, it } from 'vitest';

import type { HandRecord } from '../runtime/handStore.js';
import {
  createTenantRemoteHandAuthTokenResolver,
  evaluateTenantHandAttachPolicy,
  selectTenantRemoteHandsForRegistration,
} from '../runtime/tenantRemoteHandResolver.js';
import { InMemorySecretVault, type SecretVault, type VaultCaller } from '../security/secretVault.js';

const baseEntry = {
  id: 'tenant-ecs',
  baseUrl: 'http://tenant-ecs-hand:3300',
  invokeTimeoutMs: 60_000,
};

function buildHand(handMetadata: Record<string, unknown>): HandRecord {
  return {
    handId: 'session-1:tenant-ecs',
    sessionId: 'session-1',
    workspaceId: 'session-1:tenant-ecs',
    type: 'server-remote',
    status: 'ready',
    endpoint: baseEntry.baseUrl,
    capabilities: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: handMetadata,
  };
}

describe('tenantRemoteHandResolver', () => {
  it('returns inline authToken when no vault ref is configured', async () => {
    const resolver = createTenantRemoteHandAuthTokenResolver({
      tenantRemoteHands: [{ ...baseEntry, authToken: 'inline-token-abc' }],
    });

    const resolved = await resolver.resolveForRegister({ ...baseEntry, authToken: 'inline-token-abc' });
    expect(resolved.authToken).toBe('inline-token-abc');
    expect(resolved.source).toBe('inline');
    expect(resolved.authTokenRef).toBeUndefined();

    const handToken = await resolver.resolveForHand(buildHand({ tenantRemoteHandId: 'tenant-ecs' }));
    expect(handToken).toBe('inline-token-abc');
  });

  it('resolves authTokenRef through the SecretVault using actor=system', async () => {
    const vault = new InMemorySecretVault();
    const ref = await vault.putSecret('__system__', 'tenant_hand', 'vault-token-xyz');
    const callers: VaultCaller[] = [];
    const trackingVault: SecretVault = {
      putSecret: vault.putSecret.bind(vault),
      rotateSecret: vault.rotateSecret.bind(vault),
      revokeSecret: vault.revokeSecret.bind(vault),
      getSecret: async (r, caller) => {
        callers.push(caller);
        return vault.getSecret(r, caller);
      },
    };
    const resolver = createTenantRemoteHandAuthTokenResolver({
      tenantRemoteHands: [{ ...baseEntry, authTokenRef: ref.id }],
      vault: trackingVault,
    });

    const resolved = await resolver.resolveForRegister({ ...baseEntry, authTokenRef: ref.id });
    expect(resolved.authToken).toBe('vault-token-xyz');
    expect(resolved.source).toBe('vault');
    expect(resolved.authTokenRef).toBe(ref.id);
    expect(callers).toHaveLength(1);
    expect(callers[0]).toMatchObject({
      actor: 'system',
      userId: '__system__',
    });

    const handToken = await resolver.resolveForHand(buildHand({ tenantRemoteHandId: 'tenant-ecs' }));
    expect(handToken).toBe('vault-token-xyz');
  });

  it('throws when an entry uses authTokenRef but no vault is configured', async () => {
    const resolver = createTenantRemoteHandAuthTokenResolver({
      tenantRemoteHands: [{ ...baseEntry, authTokenRef: 'missing-vault' }],
    });

    await expect(resolver.resolveForRegister({ ...baseEntry, authTokenRef: 'missing-vault' }))
      .rejects.toThrow(/no SecretVault is configured/);
  });

  it('propagates vault lookup failure for unknown refs', async () => {
    const resolver = createTenantRemoteHandAuthTokenResolver({
      tenantRemoteHands: [{ ...baseEntry, authTokenRef: 'does-not-exist' }],
      vault: new InMemorySecretVault(),
    });

    await expect(resolver.resolveForRegister({ ...baseEntry, authTokenRef: 'does-not-exist' }))
      .rejects.toThrow(/secret not found/);
  });

  it('returns undefined when the hand record lacks tenantRemoteHandId metadata', async () => {
    const resolver = createTenantRemoteHandAuthTokenResolver({
      tenantRemoteHands: [{ ...baseEntry, authToken: 'inline-token-abc' }],
    });

    expect(await resolver.resolveForHand(buildHand({}))).toBeUndefined();
  });

  it('returns undefined when the hand id is not in the configured tenant entries', async () => {
    const resolver = createTenantRemoteHandAuthTokenResolver({
      tenantRemoteHands: [{ ...baseEntry, authToken: 'inline-token-abc' }],
    });

    expect(await resolver.resolveForHand(buildHand({ tenantRemoteHandId: 'unknown-id' }))).toBeUndefined();
  });

  it('reads tenant remote hand entries from a dynamic source for hot config updates', async () => {
    let entries = [{ ...baseEntry, authToken: 'first-token-abc' }];
    const resolver = createTenantRemoteHandAuthTokenResolver({
      tenantRemoteHands: () => entries,
    });

    expect(await resolver.resolveForHand(buildHand({ tenantRemoteHandId: 'tenant-ecs' }))).toBe('first-token-abc');
    entries = [{ ...baseEntry, authToken: 'second-token-xyz' }];
    expect(await resolver.resolveForHand(buildHand({ tenantRemoteHandId: 'tenant-ecs' }))).toBe('second-token-xyz');
  });
});

// B1: tenant attach policy — independently permissive (users OR tenantIds OR
// no allow-list). Both lists declared = union, not intersection.
describe('evaluateTenantHandAttachPolicy', () => {
  it('attaches every authenticated user when no allow-list is declared', () => {
    expect(evaluateTenantHandAttachPolicy({}, { username: 'alice' })).toBe(true);
    expect(evaluateTenantHandAttachPolicy({}, { userId: 'user-1' })).toBe(true);
    expect(evaluateTenantHandAttachPolicy({}, { username: 'alice', userTenantId: 'tenant-A' })).toBe(true);
  });

  it('refuses anonymous (no user identity) regardless of allow-list', () => {
    expect(evaluateTenantHandAttachPolicy({}, {})).toBe(false);
    expect(evaluateTenantHandAttachPolicy({ users: ['alice'] }, {})).toBe(false);
    expect(evaluateTenantHandAttachPolicy({ tenantIds: ['tenant-A'] }, { userTenantId: 'tenant-A' })).toBe(false);
  });

  it('attaches by users allow-list when only users is declared', () => {
    expect(evaluateTenantHandAttachPolicy({ users: ['alice', 'bob'] }, { username: 'alice' })).toBe(true);
    expect(evaluateTenantHandAttachPolicy({ users: ['alice', 'bob'] }, { username: 'carol' })).toBe(false);
  });

  it('attaches by tenantIds allow-list when only tenantIds is declared', () => {
    expect(evaluateTenantHandAttachPolicy(
      { tenantIds: ['tenant-A'] },
      { username: 'alice', userTenantId: 'tenant-A' },
    )).toBe(true);
    expect(evaluateTenantHandAttachPolicy(
      { tenantIds: ['tenant-A'] },
      { username: 'alice', userTenantId: 'tenant-B' },
    )).toBe(false);
    expect(evaluateTenantHandAttachPolicy(
      { tenantIds: ['tenant-A'] },
      { username: 'alice' /* no tenantId */ },
    )).toBe(false);
  });

  it('attaches when EITHER allow-list matches when both are declared (union, not intersection)', () => {
    const hand = { users: ['alice'], tenantIds: ['tenant-A'] };
    // username match only
    expect(evaluateTenantHandAttachPolicy(hand, { username: 'alice', userTenantId: 'tenant-Z' })).toBe(true);
    // tenant match only
    expect(evaluateTenantHandAttachPolicy(hand, { username: 'bob', userTenantId: 'tenant-A' })).toBe(true);
    // both match
    expect(evaluateTenantHandAttachPolicy(hand, { username: 'alice', userTenantId: 'tenant-A' })).toBe(true);
    // neither match
    expect(evaluateTenantHandAttachPolicy(hand, { username: 'carol', userTenantId: 'tenant-Z' })).toBe(false);
    expect(evaluateTenantHandAttachPolicy(hand, { username: 'carol' })).toBe(false);
  });

  it('does not attach when explicit rollout is disabled', () => {
    expect(evaluateTenantHandAttachPolicy(
      { rollout: { mode: 'disabled' } },
      { userId: 'ky50wfyptpafch', username: 'leozeng', userTenantId: 'kaiyan' },
    )).toBe(false);
  });

  it('does not attach new sessions when explicit rollout is drain', () => {
    expect(evaluateTenantHandAttachPolicy(
      { rollout: { mode: 'drain' } },
      { userId: 'ky50wfyptpafch', username: 'leozeng', userTenantId: 'kaiyan' },
    )).toBe(false);
  });

  it('attaches every authenticated user when explicit rollout is all', () => {
    expect(evaluateTenantHandAttachPolicy(
      { rollout: { mode: 'all' } },
      { userId: 'user-1' },
    )).toBe(true);
    expect(evaluateTenantHandAttachPolicy(
      { rollout: { mode: 'all' } },
      {},
    )).toBe(false);
  });

  it('attaches by explicit allowlist rollout using userId or username', () => {
    const hand = { rollout: { mode: 'allowlist' as const, userIds: ['ky50wfyptpafch'], usernames: ['admin'] } };
    expect(evaluateTenantHandAttachPolicy(hand, { userId: 'ky50wfyptpafch', username: 'leozeng' })).toBe(true);
    expect(evaluateTenantHandAttachPolicy(hand, { userId: 'other-user', username: 'admin' })).toBe(true);
    expect(evaluateTenantHandAttachPolicy(hand, { userId: 'other-user', username: 'other' })).toBe(false);
  });

  it('attaches by explicit tenant rollout using tenantId', () => {
    const hand = { rollout: { mode: 'tenant' as const, tenantIds: ['kaiyan'] } };
    expect(evaluateTenantHandAttachPolicy(hand, { userId: 'user-1', username: 'alice', userTenantId: 'kaiyan' })).toBe(true);
    expect(evaluateTenantHandAttachPolicy(hand, { userId: 'user-1', username: 'alice', userTenantId: 'other' })).toBe(false);
    expect(evaluateTenantHandAttachPolicy(hand, { userId: 'user-1', username: 'alice' })).toBe(false);
  });
});

describe('selectTenantRemoteHandsForRegistration', () => {
  it('returns only rollout-matching hands for the register path', () => {
    const selected = selectTenantRemoteHandsForRegistration([
      { id: 'disabled', rollout: { mode: 'disabled' as const } },
      { id: 'allowlist-hit-id', rollout: { mode: 'allowlist' as const, userIds: ['ky50wfyptpafch'] } },
      { id: 'allowlist-hit-name', rollout: { mode: 'allowlist' as const, usernames: ['leozeng'] } },
      { id: 'allowlist-miss', rollout: { mode: 'allowlist' as const, userIds: ['someone-else'] } },
      { id: 'tenant-hit', rollout: { mode: 'tenant' as const, tenantIds: ['kaiyan'] } },
      { id: 'tenant-miss', rollout: { mode: 'tenant' as const, tenantIds: ['other'] } },
      { id: 'all', rollout: { mode: 'all' as const } },
      { id: 'legacy-users-hit', users: ['leozeng'] },
      { id: 'legacy-users-miss', users: ['admin'] },
    ], {
      userId: 'ky50wfyptpafch',
      username: 'leozeng',
      userTenantId: 'kaiyan',
    });

    expect(selected.map((hand) => hand.id)).toEqual([
      'allowlist-hit-id',
      'allowlist-hit-name',
      'tenant-hit',
      'all',
      'legacy-users-hit',
    ]);
  });
});
