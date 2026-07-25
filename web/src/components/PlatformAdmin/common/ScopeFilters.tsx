import { useEffect, useMemo, useState } from "react";

import { useTenants } from "@/components/TenantManager/hooks";
import { AdminSelect, type AdminSelectOption } from "@/components/ui/admin-select";
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

  const tenantSelectOptions = useMemo<AdminSelectOption[]>(() => [
    { value: "", label: "全部组织" },
    ...tenants.map((tenant) => ({ value: tenant.id, label: tenant.name })),
  ], [tenants]);

  const userSelectOptions = useMemo<AdminSelectOption[]>(() => [
    { value: "", label: loadingUsers ? "正在加载用户…" : "全部用户" },
    ...userOptions.map((user) => ({
      value: user.id,
      label: user.realName ? `${user.realName}（${user.username}）` : user.username,
    })),
  ], [loadingUsers, userOptions]);

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <AdminSelect
        ariaLabel="按组织筛选"
        className="min-w-36"
        options={tenantSelectOptions}
        value={tenantId}
        onValueChange={(value) => onChange({ tenantId: value || null, userId: null })}
      />
      {userId !== undefined && (
        <AdminSelect
          ariaLabel="按用户筛选"
          className="min-w-44 max-w-64"
          options={userSelectOptions}
          value={userId}
          onValueChange={(value) => onChange({ userId: value || null })}
          disabled={loadingUsers}
        />
      )}
    </div>
  );
}
