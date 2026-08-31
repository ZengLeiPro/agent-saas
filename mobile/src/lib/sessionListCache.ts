import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ApiSessionListItem, BoundaryIdentity } from '@agent/shared';
import { CACHE_KEY_PREFIX, cacheKeyForIdentity, canonicalSerialize, parseCacheJson, scopedSensitiveKey } from '@agent/shared';

const LEGACY_CACHE_KEY_PREFIX = 'sessionList:';
interface CacheEntry { sessions: ApiSessionListItem[]; hasMore: boolean; }

function getCacheKey(viewAsParam: string, identity: BoundaryIdentity | null): string | null {
  const view = !viewAsParam ? 'default' : (viewAsParam.match(/viewAs=([^&]+)/)?.[1] ?? 'default');
  try { return cacheKeyForIdentity(identity, 'sessions', view); } catch { return null; }
}

export function saveSessionListCache(sessions: ApiSessionListItem[], hasMore: boolean, viewAsParam: string, identity: BoundaryIdentity | null): void {
  const key = getCacheKey(viewAsParam, identity);
  if (!key) return;
  try {
    void AsyncStorage.setItem(key, canonicalSerialize({ sessions, hasMore } satisfies CacheEntry)).catch(() => {});
  } catch { /* invalid display cache is dropped */ }
}

export async function clearSessionListCache(): Promise<void> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(`${CACHE_KEY_PREFIX}:`) && k.includes(':resource=sessions:'));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  } catch { /* silent */ }
}

export async function loadSessionListCache(viewAsParam: string, identity: BoundaryIdentity | null): Promise<CacheEntry | null> {
  const key = getCacheKey(viewAsParam, identity);
  if (!key) return null;
  try {
    // N-1 ownerless keys cannot establish ownership and are discarded.
    await AsyncStorage.removeItem(LEGACY_CACHE_KEY_PREFIX + (!viewAsParam ? 'default' : (viewAsParam.match(/viewAs=([^&]+)/)?.[1] ?? 'default')));
    let raw = await AsyncStorage.getItem(key);
    if (!raw) {
      const legacyKey = scopedSensitiveKey(LEGACY_CACHE_KEY_PREFIX + (!viewAsParam ? 'default' : (viewAsParam.match(/viewAs=([^&]+)/)?.[1] ?? 'default')), identity);
      const legacy = legacyKey ? await AsyncStorage.getItem(legacyKey) : null;
      if (legacyKey) await AsyncStorage.removeItem(legacyKey);
      if (legacy) {
        const parsed = parseCacheJson(legacy) as CacheEntry;
        if (Array.isArray(parsed.sessions)) {
          raw = canonicalSerialize({ sessions: parsed.sessions, hasMore: false } satisfies CacheEntry);
          await AsyncStorage.setItem(key, raw);
        }
      }
    }
    if (!raw) return null;
    const entry = parseCacheJson(raw) as CacheEntry;
    return entry.sessions?.length ? entry : null;
  } catch { return null; }
}
