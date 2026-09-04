import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAdminSettingsNavigation } from './useAdminSettingsNavigation';

function deps() {
  return {
    getActiveTab: () => 'chat' as const,
    getPlatformRoute: () => ({}),
    getTenantSection: () => 'overview' as const,
    getSessionId: () => 'session-1',
    getCurrentSettings: () => null,
    openState: vi.fn(),
    closeState: vi.fn(),
  };
}

describe('useAdminSettingsNavigation', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/chat/session-1');
    vi.restoreAllMocks();
  });

  it('治理设置路由已接管状态时仍能返回进入设置前的页面', () => {
    const input = deps();
    const historyGo = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    const { result } = renderHook(() => useAdminSettingsNavigation(input));

    act(() => result.current.openAdminSettings('platform', 'tenants'));
    expect(window.location.pathname).toBe('/platform-admin/settings/tenants');

    act(() => result.current.closeAdminSettings());
    expect(input.closeState).toHaveBeenCalledTimes(1);
    expect(historyGo).toHaveBeenCalledWith(-1);
  });
});
