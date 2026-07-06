import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/authFetch";
import { registerRefresh, unregisterRefresh } from "@/lib/refreshBus";

export interface RoleKitPublicConfig {
  roleKitV2Enabled: boolean;
  sanitizePreviewEnabled: boolean;
  firstDayGuideBar: {
    enabled: boolean;
    stageTimeoutMs: number;
    showOnMobile: boolean;
  };
  libraryVersion: "v1" | "v2";
}

const DEFAULT_CONFIG: RoleKitPublicConfig = {
  roleKitV2Enabled: false,
  sanitizePreviewEnabled: false,
  firstDayGuideBar: {
    enabled: false,
    stageTimeoutMs: 5_400_000,
    showOnMobile: false,
  },
  libraryVersion: "v1",
};

let cachedConfig: RoleKitPublicConfig | null = null;
let inflight: Promise<RoleKitPublicConfig> | null = null;
let hookInstanceSeq = 0;

async function fetchRoleKitConfig(force = false): Promise<RoleKitPublicConfig> {
  if (force) cachedConfig = null;
  if (!force && cachedConfig) return cachedConfig;
  if (!force && inflight) return inflight;
  inflight = (async () => {
    const res = await authFetch("/api/scenarios/config");
    if (!res.ok) return DEFAULT_CONFIG;
    const data = (await res.json()) as Partial<RoleKitPublicConfig>;
    const config: RoleKitPublicConfig = {
      ...DEFAULT_CONFIG,
      ...data,
      firstDayGuideBar: {
        ...DEFAULT_CONFIG.firstDayGuideBar,
        ...(data.firstDayGuideBar ?? {}),
      },
    };
    cachedConfig = config;
    return config;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function invalidateRoleKitConfig(): void {
  cachedConfig = null;
  inflight = null;
}

async function refreshRoleKitConfig(): Promise<RoleKitPublicConfig> {
  invalidateRoleKitConfig();
  return fetchRoleKitConfig(true);
}

function nextHookInstanceKey(): string {
  hookInstanceSeq += 1;
  return `roleKitConfig:${hookInstanceSeq}`;
}

function useStableRefreshKey(): string {
  const ref = useRef<string | null>(null);
  if (!ref.current) {
    ref.current = nextHookInstanceKey();
  }
  return ref.current;
}

export interface UseRoleKitConfigResult {
  config: RoleKitPublicConfig;
  loading: boolean;
  reload: () => void;
}

export function useRoleKitConfig(): UseRoleKitConfigResult {
  const refreshKey = useStableRefreshKey();
  const [config, setConfig] = useState<RoleKitPublicConfig>(cachedConfig ?? DEFAULT_CONFIG);
  const [loading, setLoading] = useState(!cachedConfig);

  const reload = useCallback(() => {
    setLoading(true);
    refreshRoleKitConfig()
      .then((next) => {
        setConfig(next);
      })
      .catch(() => {
        setConfig(DEFAULT_CONFIG);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchRoleKitConfig()
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch(() => {
        if (!cancelled) setConfig(DEFAULT_CONFIG);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    registerRefresh(refreshKey, async () => {
      const next = await refreshRoleKitConfig().catch(() => DEFAULT_CONFIG);
      setConfig(next);
    });
    return () => unregisterRefresh(refreshKey);
  }, [refreshKey]);

  return { config, loading, reload };
}
