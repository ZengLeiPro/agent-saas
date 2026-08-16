import { useCallback, useEffect, useState } from "react";
import { governanceAccessApi, governanceResourcesApi } from "@agent/shared/lib/governanceApi";
import { authFetch } from "@/lib/authFetch";
import { tenantsPreload } from "@/lib/preload";
import { registerRefresh, unregisterRefresh } from "@/lib/refreshBus";
import type { Tenant, CreateTenantInput, UpdateTenantInput } from "./types";

const API_BASE = "/api/tenants";

type TenantLifecyclePreview = {
  previewId: string;
  baselineDigest: string;
  expiresAt: string;
  impact: { blockers: string[] };
};

type TenantDeletePreview = {
  previewId: string;
  baselineDigest: string;
  expiresAt: string;
  blockers?: unknown[];
  idempotencyKey?: string;
};

let cachedTenants: Tenant[] | null = null;
let tenantsSkipped = false; // 非平台 admin 跳过请求
let sharedTenantsPreload: Promise<Tenant[] | null> | null = null;
const tenantSubscribers = new Set<(tenants: Tenant[]) => void>();

function publishTenants(tenants: Tenant[]): void {
  cachedTenants = tenants;
  for (const subscriber of tenantSubscribers) subscriber(tenants);
}

/**
 * 所有并发挂载共享同一个 persona 预加载判定。
 * 在该 Promise 明确组织管理员（null）前，任何实例都不得自行请求平台 /api/tenants。
 */
function resolveTenantsPreload(): Promise<Tenant[] | null> {
  if (!sharedTenantsPreload) {
    sharedTenantsPreload = tenantsPreload.then((preloaded) => {
      if (preloaded) {
        const list = preloaded as Tenant[];
        publishTenants(list);
        return list;
      }
      tenantsSkipped = true;
      return null;
    });
  }
  return sharedTenantsPreload;
}

export function useTenants() {
  const [tenants, setTenants] = useState<Tenant[]>(cachedTenants ?? []);
  const [loading, setLoading] = useState(cachedTenants === null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      await resolveTenantsPreload();
      if (tenantsSkipped) return;
      const res = await authFetch(API_BASE);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error || `HTTP ${res.status}`,
        );
      }
      const data = await res.json();
      const list = (data.tenants || []) as Tenant[];
      publishTenants(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    tenantSubscribers.add(setTenants);
    if (cachedTenants) setTenants(cachedTenants);
    return () => { tenantSubscribers.delete(setTenants); };
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

    // 并发实例只等待共享预加载，不允许第二个实例绕过 persona 判定自行 refresh。
    void resolveTenantsPreload().finally(() => setLoading(false));
  }, []);

  // 注册 refreshBus
  useEffect(() => {
    registerRefresh("tenants", refresh);
    return () => unregisterRefresh("tenants");
  }, [refresh]);

  const createTenant = async (input: CreateTenantInput) => {
    await governanceAccessApi.createTenant(input);
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

  const reorderTenants = useCallback(async (ids: string[]) => {
    const res = await authFetch(API_BASE, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || "保存组织排序失败");
    }
    await refresh();
  }, [refresh]);

  const setTenantDisabled = async (id: string, disabled: boolean) => {
    const action = disabled ? "suspend" : "resume";
    const reason = disabled ? "平台组织管理暂停组织" : "平台组织管理恢复组织";
    const preview = await governanceAccessApi.previewTenantLifecycle<TenantLifecyclePreview>(id, {
      action,
      reason,
    });
    if (preview.impact.blockers.length > 0) {
      throw new Error(`组织生命周期变更存在阻断：${preview.impact.blockers.join("、")}`);
    }
    await governanceAccessApi.updateTenantLifecycle(id, {
      action,
      reason,
      previewId: preview.previewId,
      baselineDigest: preview.baselineDigest,
      expiresAt: preview.expiresAt,
    });
    await refresh();
  };

  const deleteTenant = async (id: string, confirm: string) => {
    const reasonCode = "platform_admin_confirmed";
    const preview = await governanceResourcesApi.previewTenantDelete<TenantDeletePreview>({
      tenantId: id,
      confirm,
      reasonCode,
    });
    if (preview.blockers?.length) throw new Error("组织删除预览仍有阻断，不能提交 Change Job");
    await governanceResourcesApi.startTenantDelete({
      tenantId: id,
      confirm,
      reasonCode,
      idempotencyKey: preview.idempotencyKey ?? `tenant-delete:${id}:${preview.baselineDigest}`,
      previewId: preview.previewId,
      baselineDigest: preview.baselineDigest,
      expiresAt: preview.expiresAt,
    });
    await refresh();
  };

  return {
    tenants,
    loading,
    error,
    refresh,
    createTenant,
    updateTenant,
    reorderTenants,
    setTenantDisabled,
    deleteTenant,
  };
}
