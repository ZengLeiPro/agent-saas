import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); return Promise.resolve(); }),
    removeItem: vi.fn((key: string) => { values.delete(key); return Promise.resolve(); }),
    getAllKeys: vi.fn(() => Promise.resolve([...values.keys()])),
    multiRemove: vi.fn((keys: string[]) => { keys.forEach((key) => values.delete(key)); return Promise.resolve(); }),
  },
}));

import {
  LOCAL_APP_LOCK_POLICY_PREFIX,
  clearAllLocalAppLockPolicies,
  readLocalAppLockPolicy,
  writeLocalAppLockPolicy,
} from './localAppLockStorage';

const a = { userId: 'a', tenantId: 't1', generation: 1 };
const b = { userId: 'b', tenantId: 't1', generation: 2 };

describe('M30-02 identity-scoped local lock storage', () => {
  beforeEach(() => values.clear());

  it('does not let account B inherit account A enablement', async () => {
    await writeLocalAppLockPolicy(a, 30_000);
    await expect(readLocalAppLockPolicy(a)).resolves.toMatchObject({ enabled: true });
    await expect(readLocalAppLockPolicy(b)).resolves.toBeNull();
  });

  it('clears every policy on logout, expiry, tenant, principal, or generation boundary', async () => {
    await writeLocalAppLockPolicy(a, 30_000);
    await writeLocalAppLockPolicy(b, 30_000);
    values.set('unrelated', 'keep');
    await clearAllLocalAppLockPolicies();
    expect([...values.keys()].filter((key) => key.startsWith(LOCAL_APP_LOCK_POLICY_PREFIX))).toEqual([]);
    expect(values.get('unrelated')).toBe('keep');
  });

  it('fails closed and removes malformed policy', async () => {
    values.set(`${LOCAL_APP_LOCK_POLICY_PREFIX}bad`, '{}');
    await expect(readLocalAppLockPolicy({ userId: 'bad', tenantId: '', generation: 0 })).resolves.toBeNull();
  });
});
