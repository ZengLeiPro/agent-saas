import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '@agent/shared';
import type { UserInfo, CreateUserInput, UpdateUserInput } from '@agent/shared';

let cachedUsers: UserInfo[] | null = null;

export function useUsers() {
  const [users, setUsers] = useState<UserInfo[]>(cachedUsers || []);
  const [loading, setLoading] = useState(!cachedUsers);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await authFetch('/api/auth/users');
      if (!res.ok) throw new Error('获取用户列表失败');
      const data = await res.json() as { users: UserInfo[] };
      cachedUsers = data.users;
      setUsers(data.users);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createUser = useCallback(async (input: CreateUserInput) => {
    const res = await authFetch('/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || '创建用户失败');
    }
    await refresh();
  }, [refresh]);

  const updateUser = useCallback(async (id: string, input: UpdateUserInput) => {
    const res = await authFetch(`/api/auth/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || '更新用户失败');
    }
    await refresh();
  }, [refresh]);

  const deleteUser = useCallback(async (id: string) => {
    const res = await authFetch(`/api/auth/users/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || '删除用户失败');
    }
    await refresh();
  }, [refresh]);

  const toggleUserDisabled = useCallback(async (id: string, disabled: boolean) => {
    const res = await authFetch(`/api/auth/users/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || '切换用户状态失败');
    }
    await refresh();
  }, [refresh]);

  return { users, loading, error, refresh, createUser, updateUser, deleteUser, toggleUserDisabled };
}
