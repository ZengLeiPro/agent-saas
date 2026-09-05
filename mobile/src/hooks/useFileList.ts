import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authFetch } from '@agent/shared';
import type { FileEntry, FileListResponse } from '@agent/shared';

const CACHE_PREFIX = 'fileList:';
const RECURSIVE_PAGE_SIZE = 200;

function getCacheKey(path: string, recursive?: boolean, owner?: string, root?: boolean): string {
  return `${CACHE_PREFIX}${root ? '__root__:' : ''}${owner || ''}:${path}:${recursive ? '1' : '0'}`;
}

export function useFileList(path: string, recursive?: boolean, owner?: string, root?: boolean) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const staleRef = useRef(false);

  const fetchPage = useCallback(async (cursor: string | null, replace: boolean) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestIdRef.current;
    const cacheKey = getCacheKey(path, recursive, owner, root);

    if (replace) {
      setLoading(true);
      setLoadingMore(false);
      setError(null);
      setNextCursor(null);
      setStale(false);
      staleRef.current = false;
      // “全部”可能包含数万文件，不读写 AsyncStorage；文件夹视图保留快速缓存。
      if (!recursive) {
        try {
          const raw = await AsyncStorage.getItem(cacheKey);
          if (requestId !== requestIdRef.current) return;
          if (raw) {
            const cached = JSON.parse(raw) as { entries: FileEntry[]; parentPath: string | null };
            if (cached.entries?.length) {
              setEntries(cached.entries);
              setParentPath(cached.parentPath);
              setLoading(false);
              setStale(true);
              staleRef.current = true;
            } else {
              setEntries([]);
            }
          } else {
            setEntries([]);
          }
        } catch {
          if (requestId === requestIdRef.current) setEntries([]);
        }
      } else {
        setEntries([]);
        void AsyncStorage.removeItem(cacheKey).catch(() => {});
      }
    } else {
      setLoadingMore(true);
    }

    try {
      const params = new URLSearchParams({ path });
      if (recursive) {
        params.set('recursive', 'true');
        params.set('limit', String(RECURSIVE_PAGE_SIZE));
        if (cursor) params.set('cursor', cursor);
      }
      if (owner) params.set('owner', owner);
      if (root) params.set('root', 'true');

      const res = await authFetch(`/api/file/list?${params}`, { signal: controller.signal });
      if (requestId !== requestIdRef.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: '加载失败' })) as { error?: string };
        throw new Error(data.error || '加载失败');
      }
      const data = (await res.json()) as FileListResponse;
      if (requestId !== requestIdRef.current) return;
      setEntries((previous) => replace ? data.entries : [...previous, ...data.entries]);
      setParentPath(data.parentPath);
      setNextCursor(data.nextCursor ?? null);
      setStale(false);
      staleRef.current = false;

      if (!recursive) {
        void AsyncStorage.setItem(cacheKey, JSON.stringify({
          entries: data.entries,
          parentPath: data.parentPath,
        })).catch(() => {});
      }
    } catch (caught) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      if (replace) {
        setError(caught instanceof Error ? caught.message : '加载失败');
        if (!staleRef.current) {
          setEntries([]);
          setParentPath(null);
        }
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [owner, path, recursive, root]);

  useEffect(() => {
    void fetchPage(null, true);
    return () => {
      requestIdRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [fetchPage]);

  const refresh = useCallback(() => fetchPage(null, true), [fetchPage]);
  const loadMore = useCallback(() => {
    if (!nextCursor || loading || loadingMore) return Promise.resolve();
    return fetchPage(nextCursor, false);
  }, [fetchPage, loading, loadingMore, nextCursor]);

  return {
    entries,
    parentPath,
    loading,
    loadingMore,
    refresh,
    loadMore,
    hasMore: nextCursor !== null,
    stale,
    error,
  };
}

/** Clear all file list caches (called on logout) */
export async function clearFileListCache(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const cacheKeys = keys.filter(k => k.startsWith(CACHE_PREFIX));
    if (cacheKeys.length > 0) await AsyncStorage.multiRemove(cacheKeys);
  } catch { /* silent */ }
}
