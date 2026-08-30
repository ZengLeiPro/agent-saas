import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ApiSessionListItem, BoundaryIdentity } from '@agent/shared';
import { scopedSensitiveKey } from '@agent/shared';

const CACHE_KEY_PREFIX = 'sessionList:';
interface CacheEntry { sessions: ApiSessionListItem[]; hasMore: boolean; }

function getCacheKey(viewAsParam: string, identity: BoundaryIdentity | null): string | null {
  const view = !viewAsParam ? 'default' : (viewAsParam.match(/viewAs=([^&]+)/)?.[1] ?? 'default');
  return scopedSensitiveKey(CACHE_KEY_PREFIX + view, identity);
}

export function saveSessionListCache(sessions: ApiSessionListItem[], hasMore: boolean, viewAsParam: string, identity: BoundaryIdentity | null): void {
  const key = getCacheKey(viewAsParam, identity);
  if (!key) return;
  void AsyncStorage.setItem(key, JSON.stringify({ sessions, hasMore } satisfies CacheEntry)).catch(() => {});
}

export async function clearSessionListCache(): Promise<void> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(CACHE_KEY_PREFIX));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  } catch { /* silent */ }
}

export async function loadSessionListCache(viewAsParam: string, identity: BoundaryIdentity | null): Promise<CacheEntry | null> {
  const key = getCacheKey(viewAsParam, identity);
  if (!key) return null;
  try {
    // N-1 ownerless keys cannot establish ownership and are discarded.
    await AsyncStorage.removeItem(CACHE_KEY_PREFIX + (!viewAsParam ? 'default' : (viewAsParam.match(/viewAs=([^&]+)/)?.[1] ?? 'default')));
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    return entry.sessions?.length ? entry : null;
  } catch { return null; }
}
