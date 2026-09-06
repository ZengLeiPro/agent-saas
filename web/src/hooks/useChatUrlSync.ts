import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import {
  parseUrl,
  replaceUrl,
  buildUrl,
  buildSettingsUrl,
  replaceSettingsUrl,
  replaceAdminSettingsUrl,
  buildAdminSettingsUrl,
  buildPlatformAdminUrl,
  replacePlatformAdminUrl,
  buildTenantAdminUrl,
  replaceTenantAdminUrl,
  replaceGovernanceUrl,
  analysisHistoryStateForNavigation,
} from '@/lib/urlSync';
import { buildGovernanceUrl } from '@/lib/governanceNavigation';
import { maybeReloadOnPopstate } from '@/lib/swUpdate';
import type { ChatRouteState } from './useChatRouteState';
import type { QueuedInterjection } from '@/lib/interjectionConsumption';

export interface ChatUrlSyncDeps {
  route: ChatRouteState;
  /** `session.sessionId`（React 已提交的当前会话）。 */
  sessionId: string | null;
  selectSession: (id: string) => void;
  newSession: () => void;
  sessionIdRef: MutableRefObject<string | null>;
  immediateSessionIdRef: MutableRefObject<string | null>;
  queuedSessionIdRef: MutableRefObject<string | null>;
  mutateQueuedInterjections: (
    updater: (prev: QueuedInterjection[]) => QueuedInterjection[],
  ) => void;
  markSessionRead: (sessionId: string | null) => void;
}

/**
 * 浏览器前进/后退 → 状态，以及「URL 始终与 state 一致」的兜底同步
 * （从 useChatAppState 按域拆出，两个 effect 逻辑与依赖原样）。
 */
export function useChatUrlSync({
  route,
  sessionId,
  selectSession,
  newSession,
  sessionIdRef,
  immediateSessionIdRef,
  queuedSessionIdRef,
  mutateQueuedInterjections,
  markSessionRead,
}: ChatUrlSyncDeps) {
  const {
    activeTab,
    governanceRouteState,
    platformAdminSection,
    platformAdminEntityId,
    tenantAdminSection,
    pendingCanonicalPath,
    settingsOpen,
    settingsSection,
    adminSettings,
    setActiveTabRaw,
    setGovernanceRouteRaw,
    setPlatformAdminSectionRaw,
    setPlatformAdminEntityIdRaw,
    setTenantAdminSectionRaw,
    setPendingCanonicalPath,
    setSettingsOpen,
    setSettingsSectionRaw,
    setAdminSettingsRaw,
  } = route;
  // Popstate refs（保持最新引用避免 effect 重注册）
  const selectSessionRawRef = useRef(selectSession);
  selectSessionRawRef.current = selectSession;
  const newSessionRawRef = useRef(newSession);
  newSessionRawRef.current = newSession;

  // 浏览器前进/后退 → 解析 URL → 更新状态（不操作 URL）
  useEffect(() => {
    const handler = (event: PopStateEvent) => {
      // 只有用户真实触发的前进/后退才允许借导航应用 SW 更新；应用内部派发的
      // synthetic popstate 只是让 SPA 重读 URL，强刷会造成管理菜单随机闪屏。
      if (maybeReloadOnPopstate(event)) return;
      const {
        tab,
        sessionId: urlSessionId,
        settingsSection: urlSettingsSection,
        adminSection: urlAdminSection,
        adminEntityId: urlAdminEntityId,
        tenantAdminSection: urlTenantAdminSection,
        adminSettings: urlAdminSettings,
        governanceRoute: urlGovernanceRoute,
        canonicalPath,
      } = parseUrl();
      setGovernanceRouteRaw(urlGovernanceRoute);
      setPendingCanonicalPath(canonicalPath);
      if (urlAdminSettings) {
        // 统一设置工作区覆盖在当前产品页上；页内前进/后退只切设置叶子，不改动来源 tab。
        setSettingsOpen(false);
        setAdminSettingsRaw(urlAdminSettings);
        return;
      }
      if (urlSettingsSection) {
        setAdminSettingsRaw(null);
        setSettingsOpen(true);
        setSettingsSectionRaw(urlSettingsSection);
        return;
      }
      setSettingsOpen(false);
      setAdminSettingsRaw(null);
      if (tab === 'platform-admin') {
        setPlatformAdminSectionRaw(urlAdminSection ?? 'overview');
        setPlatformAdminEntityIdRaw(urlAdminEntityId);
      }
      if (tab === 'tenant-admin' && urlTenantAdminSection) {
        setTenantAdminSectionRaw(urlTenantAdminSection);
      }
      immediateSessionIdRef.current = urlSessionId;
      queuedSessionIdRef.current = urlSessionId;
      mutateQueuedInterjections((prev) => prev);
      setActiveTabRaw(tab);
      if (tab === 'chat') {
        if (urlSessionId && urlSessionId !== sessionIdRef.current) {
          markSessionRead(urlSessionId);
          selectSessionRawRef.current(urlSessionId);
        } else if (!urlSessionId && sessionIdRef.current) {
          newSessionRawRef.current();
        }
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markSessionRead, mutateQueuedInterjections]);

  // 兜底：确保 URL 始终与 state 一致（覆盖 delete fallback 等间接变更）
  useEffect(() => {
    if (pendingCanonicalPath) {
      const current = `${window.location.pathname}${window.location.search}`;
      if (current !== pendingCanonicalPath) {
        window.history.replaceState(
          analysisHistoryStateForNavigation('replace', pendingCanonicalPath),
          '',
          pendingCanonicalPath,
        );
      }
      setPendingCanonicalPath(null);
      return;
    }
    // 定制软件壳路由 `/apps/<iid>/<path>` 的 URL 由 AppHost 侧按 §5.2 维护
    // （`ready.path` 作 canonical、用户导航 pushState、回滚 replaceState）。
    // 这里不能用 buildUrl 兜底：activeTab 之外没有安装实例与应用内路径，
    // 兜底会把壳路径改写成 `/`，F5 深链与 route.changed 全部失效。
    if (activeTab === 'apps') return;
    const expectedUrl = buildUrl(activeTab, activeTab === 'chat' ? sessionId : null);
    if (governanceRouteState) {
      const governanceUrl = buildGovernanceUrl(governanceRouteState);
      if (governanceUrl !== `${window.location.pathname}${window.location.search}`) {
        replaceGovernanceUrl(governanceRouteState);
      }
      return;
    }
    if (adminSettings) {
      const adminUrl = buildAdminSettingsUrl(adminSettings.target, adminSettings.section);
      if (adminUrl !== window.location.pathname) {
        replaceAdminSettingsUrl(adminSettings.target, adminSettings.section);
      }
      return;
    }
    if (settingsOpen) {
      const settingsUrl = buildSettingsUrl(settingsSection);
      if (settingsUrl !== window.location.pathname) {
        replaceSettingsUrl(settingsSection);
      }
      return;
    }
    if (activeTab === 'platform-admin') {
      const expectedPath = buildPlatformAdminUrl({
        section: platformAdminSection,
        entityId: platformAdminEntityId,
      });
      if (expectedPath !== window.location.pathname) {
        replacePlatformAdminUrl({
          section: platformAdminSection,
          entityId: platformAdminEntityId,
          search: window.location.search,
        });
      }
      return;
    }
    if (activeTab === 'tenant-admin') {
      // 与 platform-admin 完全对称：路径带页签，search（筛选）原样保留
      const expectedPath = buildTenantAdminUrl({ section: tenantAdminSection });
      if (expectedPath !== window.location.pathname) {
        replaceTenantAdminUrl({ section: tenantAdminSection, search: window.location.search });
      }
      return;
    }
    if (expectedUrl !== window.location.pathname) {
      immediateSessionIdRef.current = sessionId;
      queuedSessionIdRef.current = sessionId;
      mutateQueuedInterjections((prev) => prev);
      replaceUrl(activeTab, activeTab === 'chat' ? sessionId : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sessionId,
    activeTab,
    settingsOpen,
    settingsSection,
    adminSettings,
    governanceRouteState,
    platformAdminSection,
    platformAdminEntityId,
    tenantAdminSection,
    pendingCanonicalPath,
    mutateQueuedInterjections,
  ]);
}
