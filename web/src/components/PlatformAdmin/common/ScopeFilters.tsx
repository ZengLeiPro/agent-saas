import { useEffect, useMemo, useState } from "react";

import { useTenants } from "@/components/TenantManager/hooks";
import type { UserInfo } from "@/components/UserManager/types";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "../api";

export function ScopeFilters({
  tenantId,
  userId,
  onChange,
  className,
}: {
  tenantId: string;
  userId?: string;
  onChange: (values: { tenantId?: string | null; userId?: string | null }) => void;
  className?: string;
}) {
  const { tenants } = useTenants();
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingUsers(true);
    void platformAdminApi.users({ tenantId, limit: 100 })
      .then((data) => {
        if (!cancelled) setUsers(data.items);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingUsers(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const userOptions = useMemo(() => {
    if (!userId || users.some((user) => user.id === userId)) return users;
    return [{ id: userId, username: userId, tenantId, role: "user" as const, disabled: false }, ...users] as UserInfo[];
  }, [tenantId, userId, users]);

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <select
        aria-label="按组织筛选"
        className="h-8 min-w-36 rounded-md border bg-background px-2 text-xs"
        value={tenantId}
        onChange={(event) => onChange({ tenantId: event.target.value || null, userId: null })}
      >
        <option value="">全部组织</option>
        {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
      </select>
      {userId !== undefined && (
        <select
          aria-label="按用户筛选"
          className="h-8 min-w-44 max-w-64 rounded-md border bg-background px-2 text-xs"
          value={userId}
          onChange={(event) => onChange({ userId: event.target.value || null })}
          disabled={loadingUsers}
        >
          <option value="">{loadingUsers ? "正在加载用户…" : "全部用户"}</option>
          {userOptions.map((user) => (
            <option key={user.id} value={user.id}>
              {user.realName ? `${user.realName}（${user.username}）` : user.username}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
