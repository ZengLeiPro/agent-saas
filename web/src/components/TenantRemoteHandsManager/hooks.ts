import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/authFetch";
import { registerRefresh, unregisterRefresh } from "@/lib/refreshBus";
import type {
  HealthState,
  TenantRemoteHandHealthResponse,
  TenantRemoteHandsConfig,
  TenantRemoteHandsResponse,
  TenantRemoteHandUpdate,
} from "./types";

const API_BASE = "/api/admin/tenant-remote-hands";

export function useTenantRemoteHands() {
  const [config, setConfig] = useState<TenantRemoteHandsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [healthById, setHealthById] = useState<Record<string, HealthState>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(API_BASE);
      const data = (await res.json().catch(() => ({}))) as Partial<TenantRemoteHandsResponse>;
      if (!res.ok || !data.tenantRemoteHands) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setConfig(data.tenantRemoteHands);
      setHealthById({});
      setError(null);
      setSavedAt(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    registerRefresh("tenantRemoteHands", refresh);
    return () => unregisterRefresh("tenantRemoteHands");
  }, [refresh]);

  const save = useCallback(async (hands: TenantRemoteHandUpdate[]) => {
    setSaving(true);
    try {
      const res = await authFetch(API_BASE, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantRemoteHands: { hands } }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<TenantRemoteHandsResponse>;
      if (!res.ok || !data.tenantRemoteHands) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setConfig(data.tenantRemoteHands);
      setHealthById({});
      setSavedAt(Date.now());
      setError(null);
      return data.tenantRemoteHands;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setSaving(false);
    }
  }, []);

  const probeHealth = useCallback(async (id: string) => {
    setHealthById((current) => ({ ...current, [id]: { status: "checking" } }));
    try {
      const res = await authFetch(`${API_BASE}/${encodeURIComponent(id)}/health`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as TenantRemoteHandHealthResponse;
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setHealthById((current) => ({
        ...current,
        [id]: data.status === "ok"
          ? { status: "ok", metadata: data.metadata }
          : { status: "unhealthy", detail: data.detail, metadata: data.metadata },
      }));
      return data;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setHealthById((current) => ({ ...current, [id]: { status: "unhealthy", detail } }));
      throw err;
    }
  }, []);

  return {
    config,
    loading,
    saving,
    error,
    savedAt,
    healthById,
    refresh,
    save,
    probeHealth,
  };
}
