import { useRef } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { governanceRoute } from '@/lib/governanceNavigation';
import { navigateGovernance, navigateSettingsRoute, parseUrl } from '@/lib/urlSync';
import { useChatRouteState } from './useChatRouteState';
import { useChatUrlSync } from './useChatUrlSync';
import { isAnalysisRoute, useUnifiedAnalysisWorkspace } from './useUnifiedAnalysisWorkspace';
import { useUnifiedSettingsWorkspace } from './useUnifiedSettingsWorkspace';

vi.mock('@/lib/swUpdate', () => ({
  maybeNavigateWithUpdate: () => false,
  maybeReloadOnPopstate: () => false,
}));
const noop = () => {};
type Role = 'member' | 'org_admin' | 'platform_admin';

function useWorkspace(role: Role) {
  const session = useRef<string | null>(null);
  const route = useChatRouteState({ urlState: parseUrl(), immediateSessionIdRef: session });
  useChatUrlSync({
    route,
    sessionId: null,
    sessionIdRef: session,
    immediateSessionIdRef: session,
    queuedSessionIdRef: session,
    selectSession: noop,
    newSession: noop,
    mutateQueuedInterjections: noop,
    markSessionRead: noop,
  });
  const analysis = useUnifiedAnalysisWorkspace({
    mode: isAnalysisRoute(route.governanceRouteState),
    governanceRoute: route.governanceRouteState,
    managementAccess: {
      status: 'ready',
      personalAllowed: true,
      tenantEntryAllowed: role !== 'member',
      platformEntryAllowed: role === 'platform_admin',
      retry: noop,
    },
    sessionId: null,
    setActiveTab: route.setActiveTab,
  });
  const settings = useUnifiedSettingsWorkspace({
    ...route,
    governanceRoute: route.governanceRouteState,
    isPlatformAdmin: role === 'platform_admin',
    closeOrganizationSettings: route.closeSettings,
  });
  return { route, analysis, settings };
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  window.history.pushState({}, '', '/capabilities');
});

describe('头像菜单工作区返回主内容', () => {
  it.each<Role>(['member', 'org_admin', 'platform_admin'])(
    '%s 直接打开设置时返回主内容而非另一管理页',
    async (role) => {
      window.history.replaceState(
        {},
        '',
        role === 'member'
          ? '/settings/account-security'
          : role === 'org_admin'
            ? '/tenant-admin/members/accounts'
            : '/platform-console/org-business/tenants',
      );
      const { result } = renderHook(() => useWorkspace(role));
      expect(result.current.settings.mode).toBe(true);
      act(() => result.current.settings.close());
      await waitFor(() => expect(window.location.pathname).toBe('/'));
      expect(result.current.route.activeTab).toBe('chat');
      expect(result.current.route.governanceRouteState).toBeNull();
      expect(result.current.settings.mode).toBe(false);
    },
  );
  it.each<Role>(['member', 'org_admin', 'platform_admin'])(
    '%s 设置内切页后一次返回原页面',
    async (role) => {
      const { result } = renderHook(() => useWorkspace(role));
      act(() => result.current.settings.open());
      if (role === 'member') {
        act(() => result.current.settings.navigate('personal', 'my-agent'));
        act(() =>
          navigateSettingsRoute(governanceRoute('settings.personal.my-agent', { tab: 'memory' })),
        );
      } else if (role === 'org_admin') {
        act(() => result.current.settings.navigate('tenant', 'org-members'));
        act(() =>
          navigateGovernance(
            governanceRoute('organization.members.accounts', { search: '?tab=groups' }),
          ),
        );
      } else {
        act(() => result.current.settings.navigate('platform', 'platform-tenants'));
        act(() =>
          navigateGovernance(
            governanceRoute('platform.org-business.tenants', {
              entityId: 'tenant-a',
              tab: 'overview',
            }),
          ),
        );
      }
      act(() => result.current.settings.close());
      await waitFor(() => expect(window.location.pathname).toBe('/capabilities'));
      expect(result.current.route.activeTab).toBe('capabilities');
      expect(result.current.route.governanceRouteState).toBeNull();
      expect(result.current.settings.mode).toBe(false);
    },
  );

  it.each<Role>(['org_admin', 'platform_admin'])(
    '%s 多次进入分析并切页后一次返回原页面',
    async (role) => {
      const { result } = renderHook(() => useWorkspace(role));
      for (let attempt = 0; attempt < 2; attempt++) {
        act(() => result.current.analysis.open());
        act(() =>
          result.current.analysis.navigate(
            role === 'platform_admin' ? 'platform.runtime.sessions' : 'organization.governance.qa',
          ),
        );
        act(() => result.current.analysis.close());
        await waitFor(() => expect(window.location.pathname).toBe('/capabilities'));
        expect(result.current.route.activeTab).toBe('capabilities');
        expect(result.current.route.governanceRouteState).toBeNull();
      }
    },
  );

  it.each<Role>(['org_admin', 'platform_admin'])(
    '%s 从分析进入设置，返回分析后仍能回主内容',
    async (role) => {
      const { result } = renderHook(() => useWorkspace(role));
      act(() => result.current.analysis.open());
      const analysisPath = window.location.pathname;
      act(() => result.current.settings.open());
      act(() => result.current.settings.navigate('personal', 'appearance-layout'));
      act(() => result.current.settings.close());
      await waitFor(() => expect(window.location.pathname).toBe(analysisPath));
      act(() => result.current.analysis.close());
      await waitFor(() => expect(window.location.pathname).toBe('/capabilities'));
      expect(result.current.route.governanceRouteState).toBeNull();
    },
  );

  it('分析页先浏览器后退，再点返回仍使用当前历史深度', async () => {
    const { result } = renderHook(() => useWorkspace('platform_admin'));
    act(() => result.current.analysis.open());
    const firstPath = window.location.pathname;
    act(() => result.current.analysis.navigate('platform.runtime.sessions'));
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe(firstPath));
    act(() => result.current.analysis.close());
    await waitFor(() => expect(window.location.pathname).toBe('/capabilities'));
  });
});
