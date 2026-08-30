import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async (key: string) => values.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { values.delete(key); }),
  getAllKeys: vi.fn(async () => [...values.keys()]),
  multiRemove: vi.fn(async (keys: string[]) => keys.forEach(key => values.delete(key))),
} }));

import { loadSessionListCache, saveSessionListCache } from './sessionListCache';
const A = { userId: 'a', tenantId: 'ta', generation: 1 };
const B = { userId: 'b', tenantId: 'ta', generation: 2 };
const TB = { userId: 'a', tenantId: 'tb', generation: 3 };
const NEXT = { userId: 'a', tenantId: 'ta', generation: 4 };
const session = (id: string) => ({ sessionId: id, title: id, updatedAtMs: 1 } as never);

describe('mobile M20-04 cache boundary', () => {
  beforeEach(() => values.clear());

  it('isolates account, tenant and generation', async () => {
    saveSessionListCache([session('private-a')], false, '', A);
    await Promise.resolve();
    expect((await loadSessionListCache('', A))?.sessions[0]?.sessionId).toBe('private-a');
    await expect(loadSessionListCache('', B)).resolves.toBeNull();
    await expect(loadSessionListCache('', TB)).resolves.toBeNull();
    await expect(loadSessionListCache('', NEXT)).resolves.toBeNull();
  });

  it('offline next generation cannot replay ownerless legacy session cache', async () => {
    values.set('sessionList:default', JSON.stringify({ sessions: [session('legacy')], hasMore: false }));
    await expect(loadSessionListCache('', NEXT)).resolves.toBeNull();
    expect(values.has('sessionList:default')).toBe(false);
  });

  it('unauthenticated boundary cannot read or persist', async () => {
    saveSessionListCache([session('x')], false, '', null);
    await expect(loadSessionListCache('', null)).resolves.toBeNull();
  });
});
