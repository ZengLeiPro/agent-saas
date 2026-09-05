import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/authFetch";
import type { FileEntry, FileListResponse } from "@agent/shared";

const RECURSIVE_PAGE_SIZE = 200;

export function useFileList(path: string, owner?: string, recursive?: boolean) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState(path);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const fetchPage = useCallback(async (cursor: string | null, replace: boolean) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestIdRef.current;
    if (replace) {
      setLoading(true);
      setLoadingMore(false);
      setError(null);
      setEntries([]);
      setNextCursor(null);
    } else {
      setLoadingMore(true);
    }

    try {
      const params = new URLSearchParams({ path });
      if (owner) params.set("owner", owner);
      if (recursive) {
        params.set("recursive", "true");
        params.set("limit", String(RECURSIVE_PAGE_SIZE));
        if (cursor) params.set("cursor", cursor);
      }
      const res = await authFetch(`/api/file/list?${params}`, { signal: controller.signal });
      if (requestId !== requestIdRef.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error(data.error || "Request failed");
      }
      const data: FileListResponse = await res.json();
      if (requestId !== requestIdRef.current) return;
      setEntries((previous) => replace ? data.entries : [...previous, ...data.entries]);
      setCurrentPath(data.currentPath);
      setParentPath(data.parentPath);
      setNextCursor(data.nextCursor ?? null);
    } catch (caught) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      const message = caught instanceof Error ? caught.message : "Network error";
      if (replace) {
        setError(message === "Failed to fetch" ? "Network error" : message);
        setEntries([]);
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [owner, path, recursive]);

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
    currentPath,
    parentPath,
    loading,
    loadingMore,
    error,
    hasMore: nextCursor !== null,
    refresh,
    loadMore,
  };
}
