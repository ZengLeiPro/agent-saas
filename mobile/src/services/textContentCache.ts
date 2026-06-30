import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = 'textContent:';

interface CacheEntry {
  content: string;
  modifiedAt: number;
  cachedAt: number;
}

function getCacheKey(path: string, owner?: string, root?: boolean): string {
  const prefix = root ? '__root__:' : '';
  return KEY_PREFIX + prefix + (owner ? `${owner}:${path}` : path);
}

export const textContentCache = {
  async get(path: string, owner?: string, root?: boolean): Promise<{ content: string; modifiedAt: number } | null> {
    try {
      const raw = await AsyncStorage.getItem(getCacheKey(path, owner, root));
      if (!raw) return null;
      const entry: CacheEntry = JSON.parse(raw);
      return { content: entry.content, modifiedAt: entry.modifiedAt };
    } catch {
      return null;
    }
  },

  async set(path: string, content: string, modifiedAt: number, owner?: string, root?: boolean): Promise<void> {
    try {
      const entry: CacheEntry = { content, modifiedAt, cachedAt: Date.now() };
      await AsyncStorage.setItem(getCacheKey(path, owner, root), JSON.stringify(entry));
    } catch { /* silent */ }
  },

  async clearAll(): Promise<void> {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const cacheKeys = keys.filter(k => k.startsWith(KEY_PREFIX));
      if (cacheKeys.length > 0) {
        await AsyncStorage.multiRemove(cacheKeys);
      }
    } catch { /* silent */ }
  },
};
