import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/authFetch";
import { tenantsPreload } from "@/lib/preload";
import { registerRefresh, unregisterRefresh } from "@/lib/refreshBus";
import type { Tenant, CreateTenantInput, UpdateTenantInput } from "./types";

const API_BASE = "/api/tenants";

let cachedTenants: Tenant[] | null = null;
let tenantsPreloadConsumed = false;
let tenantsSkipped = false; // 非平台 admin 跳过请求

export function useTenants() {
  const [tenants, setTenants] = useState<Tenant[]>(cachedTenants ?? []);
  const [loading, setLoading] = useState(cachedTenants === null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (tenantsSkipped) return;
    try {
      setLoading(true);
      const res = await authFetch(API_BASE);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error || `HTTP ${res.status}`,
        );
      }
      const data = await res.json();
      const list = (data.tenants || []) as Tenant[];
      cachedTenants = list;
      setTenants(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (cachedTenants) {
      setLoading(false);
      return;
    }
    if (tenantsSkipped) {
      setLoading(false);
      return;
    }

    if (!tenantsPreloadConsumed) {
      tenantsPreloadConsumed = true;
      tenantsPreload.then((preloaded) => {
        if (preloaded) {
          cachedTenants = preloaded as Tenant[];
          setTenants(cachedTenants);
        } else {
          // preload 返回 null 说明非平台 admin，跳过后续请求
          tenantsSkipped = true;
        }
        setLoading(false);
      });
    } else {
      void refresh();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 注册 refreshBus
  useEffect(() => {
    registerRefresh("tenants", refresh);
    return () => unregisterRefresh("tenants");
  }, [refresh]);

  const createTenant = async (input: CreateTenantInput) => {
    const res = await authFetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || "创建组织失败");
    }
    await refresh();
  };

  const updateTenant = async (id: string, input: UpdateTenantInput) => {
    const res = await authFetch(`${API_BASE}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || "更新组织失败");
    }
    await refresh();
  };

  const setTenantDisabled = async (id: string, disabled: boolean) => {
    const res = await authFetch(`${API_BASE}/${id}/status`, {
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

  const deleteTenant = async (id: string, confirm: string) => {
    const res = await authFetch(`${API_BASE}/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || "删除组织失败");
    }
    await refresh();
  };

  return {
    tenants,
    loading,
    error,
    refresh,
    createTenant,
    updateTenant,
    setTenantDisabled,
    deleteTenant,
  };
}
