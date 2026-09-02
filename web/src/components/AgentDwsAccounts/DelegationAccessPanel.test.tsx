import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDwsAccount } from '@agent/shared';

const { mockAuthFetch, governanceAccessApi } = vi.hoisted(() => ({
  mockAuthFetch: vi.fn(),
  governanceAccessApi: {
    getAssignment: vi.fn(),
    listMemberships: vi.fn(),
    listDirectoryGroups: vi.fn(),
    previewAssignment: vi.fn(),
    updateAssignment: vi.fn(),
  },
}));

vi.mock('@/lib/authFetch', () => ({
  authFetch: mockAuthFetch,
  setOnUnauthorized: vi.fn(),
}));

vi.mock('@agent/shared/lib/governanceApi', () => ({
  governanceAccessApi,
  governanceResourcesApi: {},
}));

import { SettingsDirtyBoundary } from '@/components/PersonalSettings/dirtyRegistry';
import { DelegationAccessPanel } from './DelegationAccessPanel';

const account = {
  accountId: 'dws-account-a',
  displayName: '销售助理账号',
  status: 'active',
  profileId: 'profile-a',
} as AgentDwsAccount;

describe('DelegationAccessPanel dirty guard', () => {
  beforeEach(() => {
    mockAuthFetch.mockReset().mockResolvedValue({
      ok: true,
      json: async () => ({
        resourceId: 'dws:delegation:resource-a',
        args: ['calendar', 'event', 'list'],
      }),
    });
    governanceAccessApi.getAssignment
      .mockReset()
      .mockResolvedValue({ version: 3, assignments: [] });
    governanceAccessApi.listMemberships.mockReset().mockResolvedValue({ memberships: [] });
    governanceAccessApi.listDirectoryGroups.mockReset().mockResolvedValue({ groups: [] });
    governanceAccessApi.previewAssignment.mockReset().mockResolvedValue({
      previewId: 'preview-a',
      baselineDigest: 'digest-a',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    governanceAccessApi.updateAssignment.mockReset().mockResolvedValue({
      changeId: 'change-a',
      auditId: 'audit-a',
      projectionStatus: 'applied',
    });
  });

  it('未生成资源时不允许把资源解析伪装成保存授权', async () => {
    let requestNavigation!: (navigation: () => void) => void;
    render(
      <SettingsDirtyBoundary>
        {(controller) => {
          requestNavigation = controller.requestNavigation;
          return <DelegationAccessPanel tenantId="tenant-a" accounts={[account]} />;
        }}
      </SettingsDirtyBoundary>,
    );

    fireEvent.change(screen.getByLabelText('已授权账号'), { target: { value: account.accountId } });
    await act(async () => requestNavigation(vi.fn()));

    expect(await screen.findByRole('heading', { name: '有未保存的更改' })).toBeTruthy();
    expect(screen.getByText(/请返回页面生成资源并配置 Assignment/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '保存并继续' }).getAttribute('disabled'),
    ).not.toBeNull();
    expect(mockAuthFetch).not.toHaveBeenCalled();
    expect(governanceAccessApi.updateAssignment).not.toHaveBeenCalled();
  });

  it('Assignment 已预览时保存并继续会真实提交授权后再离开', async () => {
    const leave = vi.fn();
    let requestNavigation!: (navigation: () => void) => void;
    render(
      <SettingsDirtyBoundary>
        {(controller) => {
          requestNavigation = controller.requestNavigation;
          return <DelegationAccessPanel tenantId="tenant-a" accounts={[account]} />;
        }}
      </SettingsDirtyBoundary>,
    );

    fireEvent.change(screen.getByLabelText('已授权账号'), { target: { value: account.accountId } });
    fireEvent.click(screen.getByRole('button', { name: '生成精确委托资源' }));
    expect(await screen.findByText('dws:delegation:resource-a')).toBeTruthy();
    await waitFor(() =>
      expect(governanceAccessApi.getAssignment).toHaveBeenCalledWith(
        'dws_delegation',
        'dws:delegation:resource-a',
        'tenant-a',
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: '添加规则' }));
    fireEvent.click(screen.getByRole('button', { name: '预览指派变更' }));
    await waitFor(() => expect(governanceAccessApi.previewAssignment).toHaveBeenCalled());
    await act(async () => requestNavigation(leave));
    fireEvent.click(await screen.findByRole('button', { name: '保存并继续' }));

    await waitFor(() =>
      expect(governanceAccessApi.updateAssignment).toHaveBeenCalledWith(
        'dws_delegation',
        'dws:delegation:resource-a',
        expect.objectContaining({
          expectedVersion: 3,
          assignments: [{ assigneeType: 'everyone', effect: 'allow' }],
          previewId: 'preview-a',
        }),
        'tenant-a',
      ),
    );
    await waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
  });
});
