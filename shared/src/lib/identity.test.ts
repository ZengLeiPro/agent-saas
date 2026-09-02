import { describe, expect, it, vi } from 'vitest';
import { INITIAL_IDENTITY_STATE, identityReducer, migrateOwnedLegacyValue, scopedSensitiveKey } from './identity';
import { runIdentityBoundary } from './identityBoundary';

const A = { userId: 'a', tenantId: 'tenant-a' };
const B = { userId: 'b', tenantId: 'tenant-a' };

describe('M20-04 identity kernel', () => {
  it('increments for principal switch, explicit logout, token expiry and tenant switch', () => {
    const a = identityReducer(INITIAL_IDENTITY_STATE, { type: 'authenticated', principal: A });
    const loggedOut = identityReducer(a, { type: 'logout' });
    const b = identityReducer(loggedOut, { type: 'authenticated', principal: B });
    const expired = identityReducer(b, { type: 'token-invalidated' });
    const tenantB = identityReducer(expired, { type: 'tenant-switched', principal: { userId: 'b', tenantId: 'tenant-b' } });
    expect([a.generation, loggedOut.generation, b.generation, expired.generation, tenantB.generation]).toEqual([1, 2, 3, 4, 5]);
  });

  it('same principal rerender is referentially stable and does not increment', () => {
    const a = identityReducer(INITIAL_IDENTITY_STATE, { type: 'authenticated', principal: A });
    expect(identityReducer(a, { type: 'authenticated', principal: { ...A } })).toBe(a);
  });

  it('scopes queue/runtime/interactions/session/draft/outbox/upload keys to the full identity', () => {
    const a = identityReducer(INITIAL_IDENTITY_STATE, { type: 'authenticated', principal: A }).identity!;
    const next = { ...a, generation: a.generation + 1 };
    for (const key of ['ws', 'queue', 'runtime', 'interactions', 'sessions', 'draft', 'outbox', 'upload']) {
      expect(scopedSensitiveKey(key, a)).not.toBe(scopedSensitiveKey(key, next));
      expect(scopedSensitiveKey(key, null)).toBeNull();
    }
  });

  it('N-1 migration accepts explicit matching ownership only', () => {
    const a = identityReducer(INITIAL_IDENTITY_STATE, { type: 'authenticated', principal: A }).identity!;
    expect(migrateOwnedLegacyValue({ value: 'ok', owner: A }, a)).toBe('ok');
    expect(migrateOwnedLegacyValue({ value: 'ownerless' }, a)).toBeNull();
    expect(migrateOwnedLegacyValue({ value: 'foreign', owner: B }, a)).toBeNull();
  });

  it('runs the atomic reset in security order and hydrates only after install', async () => {
    const calls: string[] = [];
    const fn = (name: string) => vi.fn(() => { calls.push(name); });
    await runIdentityBoundary(INITIAL_IDENTITY_STATE, { type: 'authenticated', principal: A }, {
      freezeSending: fn('freeze'), disconnectRealtime: fn('disconnect'), clearRecovery: fn('cursor'),
      clearSensitiveState: fn('sensitive'), installIdentity: fn('install'), reconnectAndHydrate: fn('hydrate'),
    });
    expect(calls).toEqual(['freeze', 'disconnect', 'cursor', 'sensitive', 'install', 'hydrate']);
  });

  it('offline logout completes locally without reconnect/hydrate', async () => {
    const a = identityReducer(INITIAL_IDENTITY_STATE, { type: 'authenticated', principal: A });
    const hydrate = vi.fn();
    const next = await runIdentityBoundary(a, { type: 'logout' }, {
      freezeSending() {}, disconnectRealtime() {}, clearRecovery() {}, clearSensitiveState() {}, installIdentity() {}, reconnectAndHydrate: hydrate,
    });
    expect(next.identity).toBeNull();
    expect(next.generation).toBe(2);
    expect(hydrate).not.toHaveBeenCalled();
  });
});
