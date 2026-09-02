import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async (key: string) => values.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { values.delete(key); }),
  getAllKeys: vi.fn(async () => [...values.keys()]),
  multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((key) => values.delete(key)); }),
} }));

import { AUTH_LIFECYCLE_JOURNAL_KEY, AuthLifecycleTransaction, CacheKeyBuilder, createCacheBackup, createStorageJournalStore, restoreCacheBackup } from '@agent/shared';
import { clearMobileCacheV2Namespace, mobileCacheAdapter } from './mobileCacheAdapter';

const owner = { tenantId: 'tenant-a', userId: 'user-a' };

describe('Mobile CacheSchemaV2 adapter parity', () => {
  beforeEach(() => values.clear());

  it('reads the same canonical bundle contract as Web', async () => {
    const backup = createCacheBackup(owner, [{ resource: 'draft-text', resourceId: 'new', type: 'draft', data: { text: 'hello' } }], '2026-09-01T00:00:00.000Z');
    await restoreCacheBackup(backup, owner, mobileCacheAdapter);
    await expect(mobileCacheAdapter.read(owner)).resolves.toEqual({ requiresFullSync: true, entries: backup.entries });
    expect([...values.values()][0]).toContain('"requiresFullSync":true');
  });

  it('recovered logout journal clears every v2 owner namespace but preserves unrelated storage', async () => {
    values.set(CacheKeyBuilder.build(owner, 'draft-text', 'new'), '{"text":"a"}');
    values.set(CacheKeyBuilder.build({ tenantId: 'tenant-b', userId: 'user-b' }, 'sessions', 'default'), '{"sessions":[]}');
    values.set('unrelated', 'keep');
    const now = '2026-09-01T00:00:00.000Z';
    values.set(AUTH_LIFECYCLE_JOURNAL_KEY, JSON.stringify({ version: 1, transactionId: 'recover-mobile', operation: 'logout', status: 'running', checkpoint: 4, startedAt: now, updatedAt: now }));
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => { values.set(key, value); },
      removeItem: async (key: string) => { values.delete(key); },
    };
    const lifecycle = new AuthLifecycleTransaction(createStorageJournalStore(storage), {
      fenceGeneration: () => undefined, disconnectWs: () => undefined, stopQueue: () => undefined,
      clearCursorEpoch: () => undefined, clearCache: clearMobileCacheV2Namespace, deleteToken: () => undefined,
    });
    await lifecycle.resume();
    expect([...values.entries()]).toEqual([['unrelated', 'keep']]);
  });
});
