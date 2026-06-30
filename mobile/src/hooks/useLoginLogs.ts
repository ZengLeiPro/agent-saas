import { useState, useCallback, useRef } from 'react';
import { authFetch } from '@agent/shared';
import type { LoginLogEntry, LoginLogResponse } from '@agent/shared';

const DEFAULT_PAGE_SIZE = 200;

export interface UseLoginLogsOptions {
  username?: string | string[];
  category?: string;
  channel?: string;
  pageSize?: number;
}

export function useLoginLogs(options: UseLoginLogsOptions) {
  const { username, category, channel, pageSize = DEFAULT_PAGE_SIZE } = options;
  const usernameKey = Array.isArray(username) ? username.join(',') : (username || '');

  const [entries, setEntries] = useState<LoginLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offsetRef = useRef(0);
  const loadingRef = useRef(false);

  const fetchPage = useCallback(async (pageOffset: number, append: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;

    try {
      if (append) setLoadingMore(true);
      else setLoading(true);

      const params = new URLSearchParams();
      if (username) {
        const val = Array.isArray(username) ? username.join(',') : username;
        if (val) params.set('username', val);
      }
      if (category) params.set('category', category);
      if (channel) params.set('channel', channel);
      params.set('offset', String(pageOffset));
      params.set('limit', String(pageSize));

      const res = await authFetch(`/api/auth/login-logs?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const data = await res.json() as LoginLogResponse;
      if (append) {
        setEntries(prev => [...prev, ...data.entries]);
      } else {
        setEntries(data.entries);
      }
      setTotal(data.total);
      offsetRef.current = pageOffset + data.entries.length;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setLoadingMore(false);
      loadingRef.current = false;
    }
  }, [usernameKey, category, channel, pageSize]);

  const refresh = useCallback(async () => {
    offsetRef.current = 0;
    await fetchPage(0, false);
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (offsetRef.current >= total) return;
    await fetchPage(offsetRef.current, true);
  }, [fetchPage, total]);

  const clearLogs = useCallback(async (before?: string, excludeUsername?: string) => {
    const query = new URLSearchParams();
    if (before) query.set('before', before);
    if (excludeUsername) query.set('excludeUsername', excludeUsername);
    const qs = query.toString();
    const res = await authFetch(`/api/auth/login-logs${qs ? `?${qs}` : ''}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || '清理失败');
    }
    offsetRef.current = 0;
    await fetchPage(0, false);
  }, [fetchPage]);

  return {
    entries,
    total,
    loading,
    loadingMore,
    error,
    hasMore: entries.length < total,
    refresh,
    loadMore,
    clearLogs,
  };
}
