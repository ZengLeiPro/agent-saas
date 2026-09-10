import { describe, expect, it } from 'vitest';

import { InMemorySecretVault } from '../security/secretVault.js';
import { DEFAULT_CODING_HAND_NETWORK_POLICY } from '../runtime/networkPolicy.js';
import { createTenantRemoteHandsRuntimeState } from './tenantRemoteHandsRuntimeUpdate.js';

describe('tenant remote hands runtime update', () => {
  it('新 dispatch 在 commit 后使用新池，旧快照在 commit 前保持', async () => {
    const vault = new InMemorySecretVault();
    const oldRef = await vault.putSecret('global', 'tenant-hand', 'old-token', {
      actor: 'system',
      userId: '__system__',
      scopes: ['secret:tenant-hand:write'],
    });
    const nextRef = await vault.putSecret('global', 'tenant-hand', 'next-token', {
      actor: 'system',
      userId: '__system__',
      scopes: ['secret:tenant-hand:write'],
    });
    const state = createTenantRemoteHandsRuntimeState({
      initial: {
        hands: [
          {
            id: 'old',
            baseUrl: 'https://old.example.com',
            authTokenRef: oldRef.id,
            networkPolicy: DEFAULT_CODING_HAND_NETWORK_POLICY,
          },
        ],
      },
      vault,
    });
    const commit = await state.prepare({
      hands: [
        {
          id: 'next',
          baseUrl: 'https://next.example.com',
          authTokenRef: nextRef.id,
          networkPolicy: DEFAULT_CODING_HAND_NETWORK_POLICY,
        },
      ],
    });
    expect(state.getHands()?.[0]?.id).toBe('old');
    commit();
    expect(state.getHands()?.[0]?.id).toBe('next');
    expect(await state.resolver.resolveForRegister(state.getHands()![0]!)).toMatchObject({
      authToken: 'next-token',
    });
  });
});
