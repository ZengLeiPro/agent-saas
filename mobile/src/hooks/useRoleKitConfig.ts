/**
 * 岗位开箱包公开配置 —— 对齐 Web `web/src/components/scenarios/useRoleKitConfig.ts`。
 *
 * 契约同源：`GET /api/scenarios/config`，字段与默认值与 Web 逐条一致；
 * 请求失败一律回落到 `DEFAULT_ROLE_KIT_CONFIG`（不抛错、不阻塞空态渲染）。
 *
 * 缓存：module 级缓存 + inflight 去重，冷启动只打一次接口；`reload()` 强刷。
 */
import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@agent/shared';

export interface RoleKitFirstDayGuideBarConfig {
  enabled: boolean;
  stageTimeoutMs: number;
  showOnMobile: boolean;
}

export interface RoleKitPublicConfig {
  roleKitV2Enabled: boolean;
  sanitizePreviewEnabled: boolean;
  firstDayGuideBar: RoleKitFirstDayGuideBarConfig;
  libraryVersion: 'v1' | 'v2' | 'v3';
}

export const DEFAULT_ROLE_KIT_CONFIG: RoleKitPublicConfig = {
  roleKitV2Enabled: false,
  sanitizePreviewEnabled: false,
  firstDayGuideBar: {
    enabled: false,
    stageTimeoutMs: 5_400_000,
    showOnMobile: false,
  },
  libraryVersion: 'v1',
};

let cachedConfig: RoleKitPublicConfig | null = null;
let inflight: Promise<RoleKitPublicConfig> | null = null;

async function fetchRoleKitConfig(force = false): Promise<RoleKitPublicConfig> {
  if (force) cachedConfig = null;
  if (!force && cachedConfig) return cachedConfig;
  if (!force && inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await authFetch('/api/scenarios/config');
      if (!res.ok) return DEFAULT_ROLE_KIT_CONFIG;
      const data = (await res.json()) as Partial<RoleKitPublicConfig>;
      const config: RoleKitPublicConfig = {
        ...DEFAULT_ROLE_KIT_CONFIG,
        ...data,
        firstDayGuideBar: {
          ...DEFAULT_ROLE_KIT_CONFIG.firstDayGuideBar,
          ...(data.firstDayGuideBar ?? {}),
        },
      };
      cachedConfig = config;
      return config;
    } catch {
      return DEFAULT_ROLE_KIT_CONFIG;
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** 测试与登录切换用：清掉 module 级缓存。 */
export function invalidateRoleKitConfig(): void {
  cachedConfig = null;
  inflight = null;
}

export interface UseRoleKitConfigResult {
  config: RoleKitPublicConfig;
  loading: boolean;
  reload: () => void;
}

export function useRoleKitConfig(): UseRoleKitConfigResult {
  const [config, setConfig] = useState<RoleKitPublicConfig>(
    cachedConfig ?? DEFAULT_ROLE_KIT_CONFIG,
  );
  const [loading, setLoading] = useState(!cachedConfig);

  const reload = useCallback(() => {
    setLoading(true);
    invalidateRoleKitConfig();
    void fetchRoleKitConfig(true)
      .then(setConfig)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchRoleKitConfig()
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { config, loading, reload };
}
