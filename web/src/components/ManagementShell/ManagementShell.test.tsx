import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { governanceRoute } from '@/lib/governanceNavigation';
import type { ManagementSettingsAccess } from '@/hooks/useManagementSettingsAccess';
import { ManagementShell } from './ManagementShell';

vi.mock('@/components/GovernanceConsole', () => ({ OrganizationScopeBanner: () => null }));
vi.mock('@/lib/urlSync', () => ({ navigateGovernance: vi.fn() }));

const access = {
  status: 'ready',
  platformEntryAllowed: true,
  tenantEntryAllowed: true,
  retry: vi.fn(),
} as unknown as ManagementSettingsAccess;

describe('ManagementShell 统一布局', () => {
  it('统一内容宽度并只在工作区外层滚动，不渲染面包屑和重复页标题', () => {
    render(
      <ManagementShell route={governanceRoute('platform.overview.overview')} access={access}>
        <div>真实内容</div>
      </ManagementShell>,
    );
    const shell = screen.getByTestId('management-shell');
    expect(shell.getAttribute('data-surface')).toBe('analytics');
    expect(shell.getAttribute('data-scroll-container')).toBe('true');
    expect(shell.className).toContain('overflow-y-auto');
    expect(screen.getByTestId('management-page-content').parentElement?.className).toContain(
      'max-w-5xl',
    );
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByText('真实内容')).toBeTruthy();
  });

  it('合并页面只展示一层 URL 驱动 Tab', () => {
    render(
      <ManagementShell
        route={governanceRoute('organization.agents.connectors', { orgId: 'kaiyan' })}
        access={access}
      >
        <div />
      </ManagementShell>,
    );
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    fireEvent.click(screen.getByRole('tab', { name: 'MCP 服务' }));
  });
});
