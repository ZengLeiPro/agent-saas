import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useGovernanceRequest', () => ({
  useGovernanceRequest: () => ({
    data: {
      platformAdmins: [
        {
          userId: 'admin-1',
          status: 'active',
          source: 'legacy_projection',
          version: 1,
          directoryProfile: { displayName: 'Admin', username: 'admin' },
        },
      ],
    },
    loading: false,
    error: null,
    retry: vi.fn(),
  }),
}));

vi.mock('@agent/shared/lib/governanceApi', () => ({
  governanceAccessApi: { listPlatformAdmins: vi.fn() },
  governanceResourcesApi: {},
}));

import { PlatformAdminsPage } from './PlatformGovernancePage';

describe('PlatformAdminsPage CRUD 入口', () => {
  it('展示添加/移除入口但因 API 缺口保持不可用', () => {
    render(<PlatformAdminsPage />);
    expect(
      (screen.getByRole('button', { name: '添加平台管理员（暂不可用）' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: '移除平台管理员（暂不可用）' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByTestId('platform-admins-api-gap').textContent).toMatch(/503/);
    expect((screen.getByRole('button', { name: '移除 Admin' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
