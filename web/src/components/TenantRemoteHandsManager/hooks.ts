import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/authFetch";
import { registerRefresh, unregisterRefresh } from "@/lib/refreshBus";
import type {
  AcsRuntimeConfig,
  AcsRuntimeConfigResponse,
  HealthState,
  TenantRemoteHandHealthResponse,
  TenantRemoteHandsConfig,
  TenantRemoteHandsResponse,
  TenantRemoteHandUpdate,
} from "./types";

const API_BASE = "/api/admin/tenant-remote-hands";
const ACS_RUNTIME_CONFIG_API = "/api/admin/runtime-operations/acs/runtime-config";

export function useAcsRuntimeConfig(refreshBlocked = false) {
  const [config, setConfig] = useState<AcsRuntimeConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const requestGenerationRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const refreshBlockedRef = useRef(refreshBlocked);
  refreshBlockedRef.current = refreshBlocked;

  useEffect(() => {
    if (refreshBlocked) setLoading(false);
  }, [refreshBlocked]);

  const refresh = useCallback(async () => {
    if (saveInFlightRef.current || refreshBlockedRef.current) return;
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    setLoading(true);
    try {
      const res = await authFetch(ACS_RUNTIME_CONFIG_API);
      const data = (await res.json().catch(() => ({}))) as Partial<AcsRuntimeConfigResponse>;
      if (!res.ok || !data.runtimeConfig) throw new Error(data.error || `HTTP ${res.status}`);
      if (generation !== requestGenerationRef.current || refreshBlockedRef.current) return;
      setConfig(data.runtimeConfig);
      setError(null);
      setSavedAt(null);
    } catch (err) {
      if (generation === requestGenerationRef.current && !refreshBlockedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === requestGenerationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    registerRefresh("acsRuntimeConfig", refresh);
    return () => unregisterRefresh("acsRuntimeConfig");
  }, [refresh]);

  const save = useCallback(async (next: AcsRuntimeConfig) => {
    saveInFlightRef.current = true;
    requestGenerationRef.current += 1;
    setLoading(false);
    setSaving(true);
    try {
      const res = await authFetch(ACS_RUNTIME_CONFIG_API, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<AcsRuntimeConfigResponse>;
      if (!res.ok || !data.runtimeConfig) throw new Error(data.error || `HTTP ${res.status}`);
      setConfig(data.runtimeConfig);
      setSavedAt(Date.now());
      setError(null);
      return data.runtimeConfig;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, []);

  return { config, loading, saving, error, savedAt, refresh, save };
}

export function useTenantRemoteHands(refreshBlocked = false) {
  const [config, setConfig] = useState<TenantRemoteHandsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [healthById, setHealthById] = useState<Record<string, HealthState>>({});
  const requestGenerationRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const refreshBlockedRef = useRef(refreshBlocked);
  refreshBlockedRef.current = refreshBlocked;

  useEffect(() => {
    if (refreshBlocked) setLoading(false);
  }, [refreshBlocked]);

  const refresh = useCallback(async () => {
    if (saveInFlightRef.current || refreshBlockedRef.current) return;
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    setLoading(true);
    try {
      const res = await authFetch(API_BASE);
      const data = (await res.json().catch(() => ({}))) as Partial<TenantRemoteHandsResponse>;
      if (!res.ok || !data.tenantRemoteHands) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (generation !== requestGenerationRef.current || refreshBlockedRef.current) return;
      setConfig(data.tenantRemoteHands);
      setHealthById({});
      setError(null);
      setSavedAt(null);
    } catch (err) {
      if (generation === requestGenerationRef.current && !refreshBlockedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === requestGenerationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    registerRefresh("tenantRemoteHands", refresh);
    return () => unregisterRefresh("tenantRemoteHands");
  }, [refresh]);

  const save = useCallback(async (hands: TenantRemoteHandUpdate[]) => {
    saveInFlightRef.current = true;
    requestGenerationRef.current += 1;
    setLoading(false);
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
      saveInFlightRef.current = false;
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
