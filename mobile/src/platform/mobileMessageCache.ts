import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BoundaryIdentity, IMessageCache, MessageItem } from '@agent/shared';
import { CACHE_KEY_PREFIX, MESSAGE_CACHE_TTL_MS, cacheKeyForIdentity, canonicalSerialize, parseCacheJson } from '@agent/shared';

const LEGACY_CACHE_PREFIX = 'msgCache:';
let activeIdentity: BoundaryIdentity | null = null;
export function setMobileMessageCacheIdentity(identity: BoundaryIdentity | null): void { activeIdentity = identity; }
function cacheKey(sessionId: string): string | null {
  try { return cacheKeyForIdentity(activeIdentity, 'messages', sessionId); } catch { return null; }
}
const MAX_MESSAGES = 500;

interface CacheEntry {
  messages: MessageItem[];
  timestamp: number;
}

export const mobileMessageCache: IMessageCache = {
  save(sessionId: string, messages: MessageItem[]): void {
    const key = cacheKey(sessionId);
    if (!key) return;
    const trimmed = messages.slice(-MAX_MESSAGES).map((m) =>
      'streaming' in m && m.streaming ? { ...m, streaming: false } : m,
    );
    const entry: CacheEntry = { messages: trimmed, timestamp: Date.now() };
    let payload: string;
    try { payload = canonicalSerialize(entry); } catch { return; }
    void AsyncStorage.setItem(key, payload)
      .then(() => evictIfNeeded())
      .catch(() => { /* silent */ });
  },

  async load(sessionId: string): Promise<MessageItem[] | null> {
    try {
      const key = cacheKey(sessionId);
      if (!key) return null;
      await AsyncStorage.removeItem(LEGACY_CACHE_PREFIX + sessionId);
      const raw = await AsyncStorage.getItem(key);
      if (!raw) return null;
      const entry = parseCacheJson(raw) as CacheEntry;
      if (Date.now() - entry.timestamp > MESSAGE_CACHE_TTL_MS) {
        await AsyncStorage.removeItem(key);
        return null;
      }
      return entry.messages.map(m =>
        m.type === 'user' && m.status === 'pending' ? { ...m, status: 'failed' as const } : m
      );
    } catch {
      return null;
    }
  },

  async clear(sessionId: string): Promise<void> {
    try {
      const key = cacheKey(sessionId);
      if (key) await AsyncStorage.removeItem(key);
    } catch { /* silent */ }
  },
};

/** 清除所有消息缓存（登出时调用） */
export async function clearAllMessageCache(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const cacheKeys = keys.filter(k => (k.startsWith(`${CACHE_KEY_PREFIX}:`) && k.includes(':resource=messages:')) || k.startsWith(LEGACY_CACHE_PREFIX));
    if (cacheKeys.length > 0) {
      await AsyncStorage.multiRemove(cacheKeys);
    }
  } catch { /* silent */ }
}

let evictCounter = 0;
async function evictIfNeeded(): Promise<void> {
  if (++evictCounter % 20 !== 0) return;
  try {
    const keys = await AsyncStorage.getAllKeys();
    const cacheKeys = keys.filter(k => k.startsWith(`${CACHE_KEY_PREFIX}:`) && k.includes(':resource=messages:'));
    if (cacheKeys.length === 0) return;

    const multiGet = await AsyncStorage.multiGet(cacheKeys);
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [key, raw] of multiGet) {
      if (!raw) continue;
      try {
        const { timestamp } = parseCacheJson(raw) as CacheEntry;
        if (now - timestamp > MESSAGE_CACHE_TTL_MS) {
          toRemove.push(key);
        }
      } catch {
        toRemove.push(key);
      }
    }

    if (toRemove.length > 0) {
      await AsyncStorage.multiRemove(toRemove);
    }
  } catch { /* silent */ }
}
