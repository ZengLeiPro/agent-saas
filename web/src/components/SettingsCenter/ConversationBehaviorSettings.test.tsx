import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  user: {
    tenantId: 'tenant-a',
    debugMode: false,
    preferences: { authorizationModeEnabled: true, lowRiskToolsAutoApproveEnabled: false },
    tenantFeatures: { debugModeAllowed: true, debugModeEnabled: true },
  },
  updateDebugMode: vi.fn(),
  updatePreferences: vi.fn(),
}));
const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  saveUserPreferences: vi.fn(),
  isDebugModeAvailable: vi.fn(() => true),
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => state }));
vi.mock('@/lib/authFetch', () => ({ authFetch: mocks.authFetch }));
vi.mock('@agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/shared')>();
  return {
    ...actual,
    saveUserPreferences: mocks.saveUserPreferences,
    isDebugModeAvailable: mocks.isDebugModeAvailable,
  };
});

import { ConversationBehaviorSettings } from './ConversationBehaviorSettings';

beforeEach(() => {
  state.user = {
    tenantId: 'tenant-a',
    debugMode: false,
    preferences: { authorizationModeEnabled: true, lowRiskToolsAutoApproveEnabled: false },
    tenantFeatures: { debugModeAllowed: true, debugModeEnabled: true },
  };
  state.updateDebugMode.mockReset();
  state.updatePreferences.mockReset();
  mocks.authFetch.mockReset();
  mocks.saveUserPreferences.mockReset();
  mocks.isDebugModeAvailable.mockReset();
  mocks.isDebugModeAvailable.mockReturnValue(true);
});

describe('ConversationBehaviorSettings', () => {
  it('以业务文案展示三档操作确认并只保存对应偏好', async () => {
    mocks.saveUserPreferences.mockResolvedValue({
      authorizationModeEnabled: false,
      lowRiskToolsAutoApproveEnabled: true,
    });
    render(<ConversationBehaviorSettings />);

    expect(screen.getByRole('radio', { name: /尽量自动执行/ }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('radio', { name: /自动执行低风险操作/ }));

    await waitFor(() =>
      expect(mocks.saveUserPreferences).toHaveBeenCalledWith({
        authorizationModeEnabled: false,
        lowRiskToolsAutoApproveEnabled: true,
      }),
    );
  });

  it('调试能力未开放时只展示组织级业务提示', () => {
    mocks.isDebugModeAvailable.mockReturnValue(false);
    render(<ConversationBehaviorSettings />);

    expect(screen.getByText('当前组织未开放此功能。')).toBeTruthy();
    expect(
      (screen.getByRole('switch', { name: '显示详细执行过程' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByText(/平台.*授权/)).toBeNull();
  });

  it('开启详细执行过程后更新当前认证态', async () => {
    mocks.authFetch.mockResolvedValue(
      new Response(JSON.stringify({ debugMode: true }), { status: 200 }),
    );
    render(<ConversationBehaviorSettings />);

    fireEvent.click(screen.getByRole('switch', { name: '显示详细执行过程' }));

    await waitFor(() => expect(state.updateDebugMode).toHaveBeenCalledWith(true));
    expect(mocks.authFetch).toHaveBeenCalledWith(
      '/api/auth/me/debug-mode',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ debugMode: true }),
      }),
    );
  });
});
