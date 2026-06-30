import { useState, useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authFetch } from '@agent/shared';
import type { FileEntry, FileListResponse } from '@agent/shared';

const CACHE_PREFIX = 'fileList:';

function getCacheKey(path: string, recursive?: boolean, owner?: string, root?: boolean): string {
  return `${CACHE_PREFIX}${root ? '__root__:' : ''}${owner || ''}:${path}:${recursive ? '1' : '0'}`;
}

export function useFileList(path: string, recursive?: boolean, owner?: string, root?: boolean) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  // Track the latest request to prevent stale responses from overwriting fresh data
  const requestIdRef = useRef(0);

  useEffect(() => {
    const thisRequestId = ++requestIdRef.current;
    let hasCache = false;

    setLoading(true);

    const cacheKey = getCacheKey(path, recursive, owner, root);

    // 1. Try cache first
    AsyncStorage.getItem(cacheKey)
      .then((raw) => {
        if (thisRequestId !== requestIdRef.current) return;
        if (raw) {
          const cached = JSON.parse(raw) as { entries: FileEntry[]; parentPath: string | null };
          if (cached.entries?.length) {
            setEntries(cached.entries);
            setParentPath(cached.parentPath);
            setLoading(false);
            setStale(true);
            hasCache = true;
          }
        }
      })
      .catch(() => {});

    // 2. Network request
    const params = new URLSearchParams({ path });
    if (recursive) params.set('recursive', 'true');
    if (owner) params.set('owner', owner);
    if (root) params.set('root', 'true');

    authFetch(`/api/file/list?${params}`)
      .then(async (res) => {
        if (thisRequestId !== requestIdRef.current) return;
        if (res.ok) {
          const data = (await res.json()) as FileListResponse;
          if (thisRequestId !== requestIdRef.current) return;
          setEntries(data.entries);
          setParentPath(data.parentPath);
          setStale(false);

          // Write cache (fire-and-forget)
          AsyncStorage.setItem(cacheKey, JSON.stringify({
            entries: data.entries,
            parentPath: data.parentPath,
          })).catch(() => {});
        } else if (!hasCache) {
          setEntries([]);
          setParentPath(null);
        }
      })
      .catch(() => {
        if (thisRequestId !== requestIdRef.current) return;
        // Network error: keep cached data if available
        if (!hasCache) {
          setEntries([]);
          setParentPath(null);
        }
      })
      .finally(() => {
        if (thisRequestId !== requestIdRef.current) return;
        setLoading(false);
      });
  }, [path, recursive, owner, root]);

  const refresh = useCallback(async () => {
    const cacheKey = getCacheKey(path, recursive, owner, root);
    const thisRequestId = ++requestIdRef.current;

    setLoading(true);

    try {
      const params = new URLSearchParams({ path });
      if (recursive) params.set('recursive', 'true');
      if (owner) params.set('owner', owner);
      if (root) params.set('root', 'true');

      const res = await authFetch(`/api/file/list?${params}`);
      if (thisRequestId !== requestIdRef.current) return;
      if (res.ok) {
        const data = (await res.json()) as FileListResponse;
        setEntries(data.entries);
        setParentPath(data.parentPath);
        setStale(false);
        AsyncStorage.setItem(cacheKey, JSON.stringify({
          entries: data.entries,
          parentPath: data.parentPath,
        })).catch(() => {});
      }
    } catch { /* keep current data */ }
    finally {
      if (thisRequestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [path, recursive, owner, root]);

  return { entries, parentPath, loading, refresh, stale };
}

/** Clear all file list caches (called on logout) */
export async function clearFileListCache(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const cacheKeys = keys.filter(k => k.startsWith(CACHE_PREFIX));
    if (cacheKeys.length > 0) {
      await AsyncStorage.multiRemove(cacheKeys);
    }
  } catch { /* silent */ }
}
