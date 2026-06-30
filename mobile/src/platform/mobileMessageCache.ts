import AsyncStorage from '@react-native-async-storage/async-storage';
import type { IMessageCache, MessageItem } from '@agent/shared';
import { MESSAGE_CACHE_TTL_MS } from '@agent/shared';

const CACHE_PREFIX = 'msgCache:';
const MAX_MESSAGES = 500;

interface CacheEntry {
  messages: MessageItem[];
  timestamp: number;
}

export const mobileMessageCache: IMessageCache = {
  save(sessionId: string, messages: MessageItem[]): void {
    const trimmed = messages.slice(-MAX_MESSAGES).map((m) =>
      'streaming' in m && m.streaming ? { ...m, streaming: false } : m,
    );
    const entry: CacheEntry = { messages: trimmed, timestamp: Date.now() };
    void AsyncStorage.setItem(CACHE_PREFIX + sessionId, JSON.stringify(entry))
      .then(() => evictIfNeeded())
      .catch(() => { /* silent */ });
  },

  async load(sessionId: string): Promise<MessageItem[] | null> {
    try {
      const raw = await AsyncStorage.getItem(CACHE_PREFIX + sessionId);
      if (!raw) return null;
      const entry: CacheEntry = JSON.parse(raw);
      if (Date.now() - entry.timestamp > MESSAGE_CACHE_TTL_MS) {
        await AsyncStorage.removeItem(CACHE_PREFIX + sessionId);
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
      await AsyncStorage.removeItem(CACHE_PREFIX + sessionId);
    } catch { /* silent */ }
  },
};

/** 清除所有消息缓存（登出时调用） */
export async function clearAllMessageCache(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const cacheKeys = keys.filter(k => k.startsWith(CACHE_PREFIX));
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
    const cacheKeys = keys.filter(k => k.startsWith(CACHE_PREFIX));
    if (cacheKeys.length === 0) return;

    const multiGet = await AsyncStorage.multiGet(cacheKeys);
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [key, raw] of multiGet) {
      if (!raw) continue;
      try {
        const { timestamp } = JSON.parse(raw) as CacheEntry;
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
