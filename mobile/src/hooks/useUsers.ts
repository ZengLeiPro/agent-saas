import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '@agent/shared';
import type { UserInfo } from '@agent/shared';

/**
 * 用户列表只读 hook。
 *
 * 09-04 拍板：移动端定位「员工使用端」，用户管理（增删改 / 启禁用 / 角色与租户）
 * 一律走 Web 管理后台；服务端 `authLegacyWriteGate` 也已把
 * POST/PATCH/DELETE `/api/auth/users*` 封死（409 MIGRATION_LEGACY_WRITE_SEALED）。
 * 因此这里只保留 `GET /api/auth/users` 列表读取，
 * 仅供管理员在文件页按 owner 过滤等只读场景使用。
 */
export function useUsers(enabled = true) {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setUsers([]);
      setLoading(false);
      setError(null);
      return;
    }
    try {
      const res = await authFetch('/api/auth/users');
      if (!res.ok) throw new Error('获取用户列表失败');
      const data = await res.json() as { users: UserInfo[] };
      setUsers(data.users);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { users, loading, error, refresh };
}
