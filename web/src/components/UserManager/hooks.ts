import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/authFetch";
import { usersPreload } from "@/lib/preload";
import { registerRefresh, unregisterRefresh } from "@/lib/refreshBus";
import type { UserInfo, CreateUserInput, UpdateUserInput, LoginLogEntry, LoginLogResponse, LoginEvent } from "./types";

const API_BASE = "/api/auth";

let cachedUsers: UserInfo[] | null = null;
let usersPreloadConsumed = false;
let usersSkipped = false; // 非 admin 用户跳过请求

export function useUsers() {
  const [users, setUsers] = useState<UserInfo[]>(cachedUsers ?? []);
  const [loading, setLoading] = useState(cachedUsers === null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (usersSkipped) return; // 非 admin 不请求
    try {
      setLoading(true);
      const res = await authFetch(`${API_BASE}/users`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const list = data.users || [];
      cachedUsers = list;
      setUsers(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (cachedUsers) { setLoading(false); return; }
    if (usersSkipped) { setLoading(false); return; }

    if (!usersPreloadConsumed) {
      usersPreloadConsumed = true;
      usersPreload.then((preloaded) => {
        if (preloaded) {
          cachedUsers = preloaded as UserInfo[];
          setUsers(cachedUsers);
        } else {
          // preload 返回 null 说明非 admin，跳过后续请求
          usersSkipped = true;
        }
        setLoading(false);
      });
    } else {
      void refresh();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 注册 refreshBus
  useEffect(() => {
    registerRefresh("users", refresh);
    return () => unregisterRefresh("users");
  }, [refresh]);

  const createUser = async (input: CreateUserInput) => {
    const res = await authFetch(`${API_BASE}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || "创建用户失败");
    }
    await refresh();
  };

  const updateUser = async (id: string, input: UpdateUserInput) => {
    const res = await authFetch(`${API_BASE}/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || "更新用户失败");
    }
    await refresh();
  };

  const deleteUser = async (id: string) => {
    const res = await authFetch(`${API_BASE}/users/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || "删除用户失败");
    }
    await refresh();
  };

  const toggleUserDisabled = async (id: string, disabled: boolean) => {
    const res = await authFetch(`${API_BASE}/users/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || "操作失败");
    }
    await refresh();
  };

  return { users, loading, error, refresh, createUser, updateUser, deleteUser, toggleUserDisabled };
}

// ---- Login Logs ----

export interface LoginLogFilters {
  username?: string | string[];
  event?: LoginEvent;
  category?: string;
  channel?: string;
  startTime?: string;
  endTime?: string;
}

const LOG_PAGE_SIZE = 200;

export function useLoginLogs(filters: LoginLogFilters) {
  const [entries, setEntries] = useState<LoginLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const fetchPage = useCallback(async (pageOffset: number) => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (filters.username) {
        const val = Array.isArray(filters.username) ? filters.username.join(',') : filters.username;
        if (val) params.set("username", val);
      }
      if (filters.event) params.set("event", filters.event);
      if (filters.category) params.set("category", filters.category);
      if (filters.channel) params.set("channel", filters.channel);
      if (filters.startTime) params.set("startTime", filters.startTime);
      if (filters.endTime) params.set("endTime", filters.endTime);
      params.set("offset", String(pageOffset));
      params.set("limit", String(LOG_PAGE_SIZE));

      const res = await authFetch(`${API_BASE}/login-logs?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      }
      const data: LoginLogResponse = await res.json();
      setEntries(data.entries);
      setTotal(data.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.isArray(filters.username) ? filters.username.join(',') : (filters.username || ''), filters.event, filters.category, filters.channel, filters.startTime, filters.endTime]);

  const refresh = useCallback(() => {
    setOffset(0);
    return fetchPage(0);
  }, [fetchPage]);

  const nextPage = useCallback(() => {
    const next = offset + LOG_PAGE_SIZE;
    if (next < total) {
      setOffset(next);
      void fetchPage(next);
    }
  }, [offset, total, fetchPage]);

  const prevPage = useCallback(() => {
    const prev = Math.max(0, offset - LOG_PAGE_SIZE);
    if (prev !== offset) {
      setOffset(prev);
      void fetchPage(prev);
    }
  }, [offset, fetchPage]);

  const clearLogs = useCallback(async (before?: string) => {
    const params = before ? `?before=${encodeURIComponent(before)}` : "";
    const res = await authFetch(`${API_BASE}/login-logs${params}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || "清理失败");
    }
    setOffset(0);
    await fetchPage(0);
  }, [fetchPage]);

  return {
    entries, total, loading, error,
    offset, limit: LOG_PAGE_SIZE,
    refresh, nextPage, prevPage, clearLogs,
  };
}
