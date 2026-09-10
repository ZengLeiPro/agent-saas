import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { governanceRoute } from '@/lib/governanceNavigation';
import type { ManagementSettingsAccess } from '@/hooks/useManagementSettingsAccess';
import { SettingsPanelHeader } from '@/components/SettingsCenter/SettingsPanelHeader';
import { ManagementShell } from './ManagementShell';

const navigationMocks = vi.hoisted(() => ({ navigateGovernance: vi.fn() }));

vi.mock('@/components/GovernanceConsole', () => ({
  OrganizationScopeBanner: ({ className }: { className?: string }) => (
    <div className={className} data-testid="organization-scope-banner" />
  ),
}));
vi.mock('@/lib/urlSync', () => navigationMocks);

const access = {
  status: 'ready',
  platformEntryAllowed: true,
  tenantEntryAllowed: true,
  retry: vi.fn(),
} as unknown as ManagementSettingsAccess;

describe('ManagementShell 统一布局', () => {
  it('所有注册详情页在统一页头返回列表，并保留来源筛选与组织范围', () => {
    const view = render(
      <ManagementShell route={governanceRoute('platform.org-business.users', { entityId: 'user-1', search: '?q=王&tenantId=acme' })} access={access}>
        <div />
      </ManagementShell>,
    );
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
    expect(navigationMocks.navigateGovernance).toHaveBeenLastCalledWith(expect.objectContaining({
      routeId: 'platform.org-business.users', entityId: null, search: '?q=王&tenantId=acme',
    }));

    view.rerender(
      <ManagementShell route={governanceRoute('organization.members.member', { orgId: 'acme', entityId: 'user-1', tab: 'access', search: '?status=active' })} access={access}>
        <div />
      </ManagementShell>,
    );
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
    expect(navigationMocks.navigateGovernance).toHaveBeenLastCalledWith(expect.objectContaining({
      routeId: 'organization.members.list', orgId: 'acme', entityId: null, search: '?status=active',
    }));
  });

  it('统一内容宽度并只在工作区外层滚动，以注册表标题渲染统一页头', () => {
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
      'max-w-6xl',
    );
    expect(screen.getByTestId('management-page-content').className).toContain('[&>*]:max-w-none');
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: '平台总览' })).toBeTruthy();
    expect(screen.getByText('真实内容')).toBeTruthy();
  });

  it('清除子页面重复的页级宽度约束，使页头与首块内容共用同一坐标系', () => {
    render(
      <ManagementShell route={governanceRoute('platform.governance.system-prompts')} access={access}>
        <div className="mx-auto w-full max-w-6xl">首块内容</div>
      </ManagementShell>,
    );

    const content = screen.getByTestId('management-page-content');
    expect(content.className).toContain('[&>*]:mx-0');
    expect(content.className).toContain('[&>*]:max-w-none');
  });

  it('收口子页面重复标题并将页面操作提升到统一页头', () => {
    render(
      <ManagementShell route={governanceRoute('platform.resource-center.models')} access={access}>
        <SettingsPanelHeader title="模型配置" actions={<button type="button">新增模型</button>} />
      </ManagementShell>,
    );

    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2, name: '模型' })).toBeTruthy();
    expect(
      screen
        .getByTestId('management-page-actions')
        .contains(screen.getByRole('button', { name: '新增模型' })),
    ).toBe(true);
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
    expect(screen.getByTestId('organization-scope-banner').className).toContain('mb-4');
    expect(screen.getByTestId('organization-scope-banner').className).toContain('rounded-lg');
    fireEvent.click(screen.getByRole('tab', { name: 'MCP 服务' }));
  });
});
