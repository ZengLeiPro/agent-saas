import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ApiSessionListItem } from '@agent/shared';

const CACHE_KEY_PREFIX = 'sessionList:';

interface CacheEntry {
  sessions: ApiSessionListItem[];
  hasMore: boolean;
}

function getCacheKey(viewAsParam: string): string {
  if (!viewAsParam) return CACHE_KEY_PREFIX + 'default';
  const match = viewAsParam.match(/viewAs=([^&]+)/);
  return CACHE_KEY_PREFIX + (match?.[1] ?? 'default');
}

/** 保存会话列表到本地缓存（fire-and-forget） */
export function saveSessionListCache(
  sessions: ApiSessionListItem[],
  hasMore: boolean,
  viewAsParam: string,
): void {
  const entry: CacheEntry = { sessions, hasMore };
  void AsyncStorage.setItem(getCacheKey(viewAsParam), JSON.stringify(entry)).catch(() => {});
}

/** 清除所有会话列表缓存（登出时调用） */
export async function clearSessionListCache(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const cacheKeys = keys.filter(k => k.startsWith(CACHE_KEY_PREFIX));
    if (cacheKeys.length > 0) {
      await AsyncStorage.multiRemove(cacheKeys);
    }
  } catch { /* silent */ }
}

/** 读取本地缓存的会话列表 */
export async function loadSessionListCache(
  viewAsParam: string,
): Promise<{ sessions: ApiSessionListItem[]; hasMore: boolean } | null> {
  try {
    const raw = await AsyncStorage.getItem(getCacheKey(viewAsParam));
    if (!raw) return null;
    const entry: CacheEntry = JSON.parse(raw);
    if (!entry.sessions?.length) return null;
    return { sessions: entry.sessions, hasMore: entry.hasMore };
  } catch {
    return null;
  }
}
