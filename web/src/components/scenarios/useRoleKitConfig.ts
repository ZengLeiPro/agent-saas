import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/authFetch";

export interface RoleKitPublicConfig {
  roleKitV2Enabled: boolean;
  sanitizePreviewEnabled: boolean;
  firstDayGuideBar: {
    enabled: boolean;
    stageTimeoutMs: number;
    showOnMobile: boolean;
  };
  roleSwitcher: {
    enabled: boolean;
    position: "top-left" | "top-right";
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
  roleSwitcher: {
    enabled: false,
    position: "top-right",
  },
  libraryVersion: "v1",
};

let cachedConfig: RoleKitPublicConfig | null = null;
let inflight: Promise<RoleKitPublicConfig> | null = null;

async function fetchRoleKitConfig(): Promise<RoleKitPublicConfig> {
  if (cachedConfig) return cachedConfig;
  if (!inflight) {
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
        roleSwitcher: {
          ...DEFAULT_CONFIG.roleSwitcher,
          ...(data.roleSwitcher ?? {}),
        },
      };
      cachedConfig = config;
      return config;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export interface UseRoleKitConfigResult {
  config: RoleKitPublicConfig;
  loading: boolean;
  reload: () => void;
}

export function useRoleKitConfig(): UseRoleKitConfigResult {
  const [config, setConfig] = useState<RoleKitPublicConfig>(cachedConfig ?? DEFAULT_CONFIG);
  const [loading, setLoading] = useState(!cachedConfig);

  const reload = useCallback(() => {
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

  useEffect(() => reload(), [reload]);

  return { config, loading, reload };
}
