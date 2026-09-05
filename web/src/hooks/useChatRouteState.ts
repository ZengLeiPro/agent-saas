import { useCallback, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { AppTab } from '@/types/sidebar';
import type { CanonicalSettingsSectionId } from '@/types/settings';
import type { AdminSettingsState, PlatformAdminSection, TenantAdminSection } from '@/lib/urlSync';
import {
  parseUrl,
  pushUrl,
  replaceUrl,
  pushPlatformAdminUrl,
  pushTenantAdminUrl,
  normalizeTenantAdminSection,
  preserveScopeSearch,
  preserveSearchKeys,
  TENANT_ADMIN_SCOPE_KEYS,
  pushGovernanceUrl,
  replaceGovernanceUrl,
} from '@/lib/urlSync';
import { governanceRoute, type GovernanceRouteState } from '@/lib/governanceNavigation';
import { reportActivity } from '@agent/shared';
import { usePersonalSettingsNavigation } from '@/hooks/usePersonalSettingsNavigation';
import { useAdminSettingsNavigation } from '@/hooks/useAdminSettingsNavigation';

export type ChatUrlState = ReturnType<typeof parseUrl>;

export interface ChatRouteStateDeps {
  urlState: ChatUrlState;
  /** 点击切换时同帧更新的当前会话 id（chat tab 的 URL 以它为准）。 */
  immediateSessionIdRef: MutableRefObject<string | null>;
}

/**
 * 页签 / 治理路由 / 平台与组织分析页签 / 个人与管理设置的路由状态与写入动作
 * （从 useChatAppState 按域拆出，逻辑原样；popstate 与 URL 兜底同步见 useChatUrlSync）。
 */
export function useChatRouteState({ urlState, immediateSessionIdRef }: ChatRouteStateDeps) {
  const [activeTab, setActiveTabRaw] = useState<AppTab>(urlState.tab);
  const [governanceRouteState, setGovernanceRouteRaw] = useState<GovernanceRouteState | null>(
    urlState.governanceRoute,
  );
  const [platformAdminSection, setPlatformAdminSectionRaw] = useState<PlatformAdminSection>(
    urlState.adminSection ?? 'overview',
  );
  const [platformAdminEntityId, setPlatformAdminEntityIdRaw] = useState<string | null>(
    urlState.adminEntityId,
  );
  const [tenantAdminSection, setTenantAdminSectionRaw] = useState<TenantAdminSection>(
    urlState.tenantAdminSection ?? 'overview',
  );
  const [pendingCanonicalPath, setPendingCanonicalPath] = useState<string | null>(
    urlState.canonicalPath,
  );
  const [settingsOpen, setSettingsOpen] = useState(() => urlState.settingsSection !== null);
  const [settingsSection, setSettingsSectionRaw] = useState<CanonicalSettingsSectionId>(
    urlState.settingsSection ?? 'account-security',
  );
  const [adminSettings, setAdminSettingsRaw] = useState<AdminSettingsState | null>(
    () => urlState.adminSettings,
  );
  const activeTabRef = useRef<AppTab>(activeTab);
  activeTabRef.current = activeTab;
  const governanceRouteRef = useRef<GovernanceRouteState | null>(governanceRouteState);
  governanceRouteRef.current = governanceRouteState;
  const platformAdminRouteRef = useRef<{ section: PlatformAdminSection; entityId: string | null }>({
    section: platformAdminSection,
    entityId: platformAdminEntityId,
  });
  platformAdminRouteRef.current = {
    section: platformAdminSection,
    entityId: platformAdminEntityId,
  };
  const tenantAdminSectionRef = useRef<TenantAdminSection>(tenantAdminSection);
  tenantAdminSectionRef.current = tenantAdminSection;
  const adminSettingsRef = useRef<AdminSettingsState | null>(adminSettings);
  adminSettingsRef.current = adminSettings;

  // ---- URL 路由同步 ----
  const TAB_LABELS: Partial<Record<AppTab, string>> = {
    cron: '任务中心',
    files: '文件管理',
    scenarios: '任务模板',
    capabilities: '能力中心',
  };
  const setActiveTab = useCallback((tab: AppTab) => {
    setSettingsOpen(false);
    setAdminSettingsRaw(null);
    setActiveTabRaw(tab);
    if (tab === 'platform-admin') {
      const next = governanceRoute('platform.overview.overview');
      setGovernanceRouteRaw(next);
      setPlatformAdminSectionRaw('overview');
      setPlatformAdminEntityIdRaw(null);
      replaceGovernanceUrl(next);
    } else if (tab === 'tenant-admin') {
      const current =
        governanceRouteRef.current?.area === 'organization' ? governanceRouteRef.current : null;
      const next = current ?? governanceRoute('organization.overview.overview');
      setGovernanceRouteRaw(next);
      replaceGovernanceUrl(next);
    } else {
      setGovernanceRouteRaw(null);
      replaceUrl(tab, tab === 'chat' ? immediateSessionIdRef.current : null);
    }
    // 上报非 chat/profile 的 tab 切换（profile 由 AgentProfile 组件自行上报）
    const label = TAB_LABELS[tab];
    if (label) reportActivity('page_viewed', { detail: label });
  }, []);

  /** push 版本的 setActiveTab：用 pushState 创建历史记录，供 user menu 跳转使用（浏览器后退可回到原页面） */
  const pushActiveTab = useCallback((tab: AppTab) => {
    setSettingsOpen(false);
    setAdminSettingsRaw(null);
    setActiveTabRaw(tab);
    if (tab === 'platform-admin') {
      const next = governanceRoute('platform.overview.overview');
      setGovernanceRouteRaw(next);
      setPlatformAdminSectionRaw('overview');
      setPlatformAdminEntityIdRaw(null);
      pushGovernanceUrl(next);
    } else if (tab === 'tenant-admin') {
      const current =
        governanceRouteRef.current?.area === 'organization' ? governanceRouteRef.current : null;
      const next = current ?? governanceRoute('organization.overview.overview');
      setGovernanceRouteRaw(next);
      pushGovernanceUrl(next);
    } else {
      setGovernanceRouteRaw(null);
      pushUrl(tab, tab === 'chat' ? immediateSessionIdRef.current : null);
    }
    const label = TAB_LABELS[tab];
    if (label) reportActivity('page_viewed', { detail: label });
  }, []);

  const setPlatformAdminRoute = useCallback(
    (section: PlatformAdminSection, entityId: string | null = null) => {
      setSettingsOpen(false);
      setAdminSettingsRaw(null);
      setActiveTabRaw('platform-admin');
      setPlatformAdminSectionRaw(section);
      setPlatformAdminEntityIdRaw(entityId);
      // 改造前这里丢弃整串 query：从 sessions 筛了某组织再点侧栏「执行记录」，组织筛选没了。
      // 现在按白名单透传作用域筛选（tenantId / userId）——section 私有筛选（kind/phase/cursor…）
      // 跨 section 无意义，仍然丢弃。
      pushPlatformAdminUrl({ section, entityId, search: preserveScopeSearch() });
    },
    [],
  );

  /** 切换组织分析页签：进路径 + push 历史（后退回上一个页签，而不是退出整个组织分析） */
  const setTenantAdminRoute = useCallback((section: string) => {
    const next = normalizeTenantAdminSection(section);
    setSettingsOpen(false);
    setAdminSettingsRaw(null);
    setActiveTabRaw('tenant-admin');
    setTenantAdminSectionRaw(next);
    // 切页签丢弃页内私有筛选，但带着组织作用域走
    pushTenantAdminUrl({ section: next, search: preserveSearchKeys(TENANT_ADMIN_SCOPE_KEYS) });
  }, []);

  const { openSettings, closeSettings, setSettingsSection } = usePersonalSettingsNavigation({
    getActiveTab: () => activeTabRef.current,
    getPlatformRoute: () => platformAdminRouteRef.current,
    getTenantSection: () => tenantAdminSectionRef.current,
    getSessionId: () => immediateSessionIdRef.current,
    openState: (section, route) => {
      setAdminSettingsRaw(null);
      setGovernanceRouteRaw(route);
      setSettingsOpen(true);
      setSettingsSectionRaw(section);
    },
    closeState: () => {
      setSettingsOpen(false);
      setGovernanceRouteRaw(null);
    },
  });

  const { openAdminSettings, closeAdminSettings, setAdminSettingsSection } =
    useAdminSettingsNavigation({
      getActiveTab: () => activeTabRef.current,
      getPlatformRoute: () => platformAdminRouteRef.current,
      getTenantSection: () => tenantAdminSectionRef.current,
      getSessionId: () => immediateSessionIdRef.current,
      getCurrentSettings: () => adminSettingsRef.current,
      openState: (target, section) => {
        setSettingsOpen(false);
        setGovernanceRouteRaw(null);
        setAdminSettingsRaw({ target, section });
      },
      closeState: () => setAdminSettingsRaw(null),
    });

  return {
    activeTab,
    activeTabRef,
    setActiveTabRaw,
    governanceRouteState,
    setGovernanceRouteRaw,
    platformAdminSection,
    setPlatformAdminSectionRaw,
    platformAdminEntityId,
    setPlatformAdminEntityIdRaw,
    tenantAdminSection,
    setTenantAdminSectionRaw,
    pendingCanonicalPath,
    setPendingCanonicalPath,
    settingsOpen,
    setSettingsOpen,
    settingsSection,
    setSettingsSectionRaw,
    adminSettings,
    setAdminSettingsRaw,
    setActiveTab,
    pushActiveTab,
    setPlatformAdminRoute,
    setTenantAdminRoute,
    openSettings,
    closeSettings,
    setSettingsSection,
    openAdminSettings,
    closeAdminSettings,
    setAdminSettingsSection,
  };
}

export type ChatRouteState = ReturnType<typeof useChatRouteState>;
