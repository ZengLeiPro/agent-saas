import type { BoundaryIdentity } from "@agent/shared";
import { CACHE_KEY_PREFIX, cacheKeyForIdentity, canonicalSerialize, parseCacheJson, scopedSensitiveKey } from "@agent/shared";
import type { ApiSessionListItem } from "@/lib/sessionsApi";

const CACHE_KEY = 'sessionList:default';

interface CacheEntry { sessions: ApiSessionListItem[]; hasMore: boolean; }

function keyFor(identity: BoundaryIdentity | null): string | null {
  return cacheKeyForIdentity(identity, 'sessions', 'default');
}

export function saveSessionListCache(sessions: ApiSessionListItem[], hasMore: boolean, identity: BoundaryIdentity | null): void {
  const key = keyFor(identity);
  if (!key) return;
  try { localStorage.setItem(key, canonicalSerialize({ sessions, hasMore } satisfies CacheEntry)); } catch { /* quota */ }
}

export function clearSessionListCache(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key === CACHE_KEY || key?.startsWith(`${CACHE_KEY_PREFIX}:`) && key.includes(':resource=sessions:')) localStorage.removeItem(key);
    }
  } catch { /* unavailable */ }
}

export function loadSessionListCache(identity: BoundaryIdentity | null): CacheEntry | null {
  const key = keyFor(identity);
  if (!key) return null;
  try {
    // Ownerless N-1 cache cannot prove account/tenant ownership: delete and fail closed.
    localStorage.removeItem(CACHE_KEY);
    let raw = localStorage.getItem(key);
    if (!raw) {
      const legacyKey = scopedSensitiveKey(CACHE_KEY, identity);
      const legacy = legacyKey ? localStorage.getItem(legacyKey) : null;
      if (legacyKey) localStorage.removeItem(legacyKey);
      if (legacy) {
        const parsed = parseCacheJson(legacy) as CacheEntry;
        if (Array.isArray(parsed.sessions)) {
          raw = canonicalSerialize({ sessions: parsed.sessions, hasMore: false } satisfies CacheEntry);
          localStorage.setItem(key, raw);
        }
      }
    }
    if (!raw) return null;
    const entry = parseCacheJson(raw) as CacheEntry;
    return entry.sessions?.length ? entry : null;
  } catch { return null; }
}
