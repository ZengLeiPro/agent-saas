import type { ApiSessionListItem } from "@/lib/sessionsApi";

const CACHE_KEY = 'sessionList:default';

interface CacheEntry {
  sessions: ApiSessionListItem[];
  hasMore: boolean;
}

/** 保存会话列表到本地缓存 */
export function saveSessionListCache(
  sessions: ApiSessionListItem[],
  hasMore: boolean,
): void {
  try {
    const entry: CacheEntry = { sessions, hasMore };
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch { /* silent — quota exceeded etc. */ }
}

/** 清除会话列表缓存（登出时调用） */
export function clearSessionListCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch { /* silent */ }
}

/** 读取本地缓存的会话列表 */
export function loadSessionListCache(): { sessions: ApiSessionListItem[]; hasMore: boolean } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry: CacheEntry = JSON.parse(raw);
    if (!entry.sessions?.length) return null;
    return { sessions: entry.sessions, hasMore: entry.hasMore };
  } catch {
    return null;
  }
}
