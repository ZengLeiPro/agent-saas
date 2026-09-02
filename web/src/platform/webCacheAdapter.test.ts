import { beforeEach, describe, expect, it } from 'vitest';
import { AUTH_LIFECYCLE_JOURNAL_KEY, AuthLifecycleTransaction, CacheKeyBuilder, createCacheBackup, createStorageJournalStore, restoreCacheBackup } from '@agent/shared';
import { clearWebCacheV2Namespace, webCacheAdapter } from './webCacheAdapter';

const owner = { tenantId: 'tenant-a', userId: 'user-a' };

describe('Web CacheSchemaV2 adapter parity', () => {
  beforeEach(() => localStorage.clear());

  it('commits a verified canonical bundle and marks first sync required', async () => {
    const backup = createCacheBackup(owner, [{ resource: 'draft-text', resourceId: 'new', type: 'draft', data: { text: 'hello' } }], '2026-09-01T00:00:00.000Z');
    await restoreCacheBackup(JSON.stringify(backup), owner, webCacheAdapter);
    await expect(webCacheAdapter.read(owner)).resolves.toEqual({ requiresFullSync: true, entries: backup.entries });
  });

  it('recovered logout journal clears every v2 owner namespace but preserves unrelated storage', async () => {
    localStorage.setItem(CacheKeyBuilder.build(owner, 'draft-text', 'new'), '{"text":"a"}');
    localStorage.setItem(CacheKeyBuilder.build({ tenantId: 'tenant-b', userId: 'user-b' }, 'sessions', 'default'), '{"sessions":[]}');
    localStorage.setItem('unrelated', 'keep');
    const now = '2026-09-01T00:00:00.000Z';
    localStorage.setItem(AUTH_LIFECYCLE_JOURNAL_KEY, JSON.stringify({ version: 1, transactionId: 'recover-web', operation: 'logout', status: 'running', checkpoint: 4, startedAt: now, updatedAt: now }));
    const lifecycle = new AuthLifecycleTransaction(createStorageJournalStore(localStorage), {
      fenceGeneration: () => undefined, disconnectWs: () => undefined, stopQueue: () => undefined,
      clearCursorEpoch: () => undefined, clearCache: clearWebCacheV2Namespace, deleteToken: () => undefined,
    });
    await lifecycle.resume();
    expect([...Array(localStorage.length)].map((_, index) => localStorage.key(index)).filter(Boolean)).toEqual(['unrelated']);
    expect(localStorage.getItem('unrelated')).toBe('keep');
  });
});
