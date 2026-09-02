import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKeyForIdentity, type BoundaryIdentity, type MessageItem } from '@agent/shared';

const values = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { values.delete(key); }),
    getAllKeys: vi.fn(async () => [...values.keys()]),
    multiGet: vi.fn(async (keys: string[]) => keys.map((key) => [key, values.get(key) ?? null])),
    multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((key) => values.delete(key)); }),
  },
}));

import {
  createMobileMessageCacheForIdentity,
  mobileMessageCache,
  setMobileMessageCacheIdentity,
} from './mobileMessageCache';

const identityA: BoundaryIdentity = { tenantId: 'tenant', userId: 'A', generation: 1 };
const identityB: BoundaryIdentity = { tenantId: 'tenant', userId: 'B', generation: 2 };
const messagesA: MessageItem[] = [{ id: 'a-message', type: 'text', content: 'A secret' }];

describe('Mobile message cache identity ownership', () => {
  beforeEach(() => {
    values.clear();
    setMobileMessageCacheIdentity(null);
  });

  it('旧 hook 的绑定 cache 在全局身份切到 B 后仍只写 A namespace', async () => {
    const requestCacheA = createMobileMessageCacheForIdentity(identityA);
    setMobileMessageCacheIdentity(identityB);

    requestCacheA.save('session-a', messagesA);
    await vi.waitFor(() => {
      expect(values.has(cacheKeyForIdentity(identityA, 'messages', 'session-a')!)).toBe(true);
    });
    expect(values.has(cacheKeyForIdentity(identityB, 'messages', 'session-a')!)).toBe(false);
  });

  it('平台动态 cache 仍跟随当前身份供同步调用方使用', async () => {
    setMobileMessageCacheIdentity(identityB);
    mobileMessageCache.save('session-b', messagesA);

    await vi.waitFor(() => {
      expect(values.has(cacheKeyForIdentity(identityB, 'messages', 'session-b')!)).toBe(true);
    });
  });
});
