import { useState, useEffect, useCallback } from "react";
import { authFetch } from "@/lib/authFetch";
import type { FileEntry, FileListResponse } from "@agent/shared";

export function useFileList(path: string, owner?: string, recursive?: boolean) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState(path);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchList = useCallback(async (targetPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ path: targetPath });
      if (owner) params.set("owner", owner);
      if (recursive) params.set("recursive", "true");
      const res = await authFetch(`/api/file/list?${params}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Request failed" }));
        setError(data.error || "Request failed");
        setEntries([]);
        return;
      }
      const data: FileListResponse = await res.json();
      setEntries(data.entries);
      setCurrentPath(data.currentPath);
      setParentPath(data.parentPath);
    } catch {
      setError("Network error");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [owner, recursive]);

  useEffect(() => {
    void fetchList(path);
  }, [path, fetchList]);

  const refresh = useCallback(() => {
    void fetchList(path);
  }, [path, fetchList]);

  return { entries, currentPath, parentPath, loading, error, refresh };
}
