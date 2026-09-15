import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { governanceRoute } from '@/lib/governanceNavigation';
import type { ManagementSettingsAccess } from '@/hooks/useManagementSettingsAccess';
import { SettingsPanelHeader } from '@/components/SettingsCenter/SettingsPanelHeader';
import { ManagementShell } from './ManagementShell';

const navigationMocks = vi.hoisted(() => ({ navigateGovernance: vi.fn() }));

const authState = vi.hoisted(() => ({ isPlatformAdmin: false }));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isPlatformAdmin: authState.isPlatformAdmin, user: { tenantId: 'acme' } }),
}));
vi.mock('@/components/GovernanceConsole', () => ({
  OrganizationScopeBanner: ({ className }: { className?: string }) => (
    <div className={className} data-testid="organization-scope-banner" />
  ),
  GovernanceCapabilityNotice: ({ title, mode }: { title: string; mode?: string }) => (
    <div data-testid="organization-scope-gate" data-mode={mode}>
      <h2>{title}</h2>
    </div>
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
    expect(shell.getAttribute('data-layout')).toBe('dashboard');
    expect(shell.getAttribute('data-scroll-container')).toBe('true');
    expect(shell.className).toContain('overflow-auto');
    expect(shell.className).toContain('settings-product-surface');
    const widthBoundary = screen.getByTestId('settings-page-width-boundary');
    expect(widthBoundary.className).toContain('w-full');
    expect(widthBoundary.className).not.toContain('max-w-6xl');
    expect(screen.getByTestId('management-page-content').parentElement).toBe(widthBoundary);
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
    expect(content.parentElement).toBe(screen.getByTestId('settings-page-width-boundary'));
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
    expect(screen.getByRole('tablist').getAttribute('data-tabs-variant')).toBe('primary');
    expect(screen.getByRole('tablist').getAttribute('data-tabs-layout')).toBe('full');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toContain('management-page-tab');
    expect(screen.getByTestId('organization-scope-banner').className).toContain('mb-4');
    expect(screen.getByTestId('organization-scope-banner').className).toContain('rounded-lg');
    fireEvent.click(screen.getByRole('tab', { name: 'MCP 服务' }));
    fireEvent.keyDown(screen.getByRole('tab', { name: 'MCP 服务' }), { key: 'ArrowRight' });
    expect(navigationMocks.navigateGovernance).toHaveBeenLastCalledWith(expect.objectContaining({
      routeId: 'organization.agents.connector-mappings',
    }));
  });

  it('只有两个入口的页面使用紧凑一级标签', () => {
    render(
      <ManagementShell
        route={governanceRoute('organization.agents.skills', { orgId: 'kaiyan' })}
        access={access}
      >
        <div />
      </ManagementShell>,
    );

    const tablist = screen.getByRole('tablist', { name: '技能页面切换' });
    expect(tablist.getAttribute('data-tabs-layout')).toBe('compact');
    expect(tablist.className).toContain('md:w-72');
  });
  beforeEach(() => {
    authState.isPlatformAdmin = false;
    navigationMocks.navigateGovernance.mockReset();
  });

  it('平台管理员未选择组织时只显示紧凑引导，不渲染子 Tab 与内容', () => {
    authState.isPlatformAdmin = true;
    render(
      <ManagementShell
        route={governanceRoute('organization.agents.business-systems')}
        access={access}
      >
        <div>业务系统内容</div>
      </ManagementShell>,
    );
    expect(screen.getByTestId('organization-scope-banner')).toBeTruthy();
    expect(screen.getByTestId('organization-scope-gate')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '请先选择要管理的组织' })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByTestId('management-page-content')).toBeNull();
    expect(screen.queryByText('业务系统内容')).toBeNull();
  });

  it('平台管理员选中组织后跨页面保留 org 并渲染内容与 Tab', () => {
    authState.isPlatformAdmin = true;
    render(
      <ManagementShell
        route={governanceRoute('organization.agents.skills', { orgId: 'kaiyan' })}
        access={access}
      >
        <div>技能内容</div>
      </ManagementShell>,
    );
    expect(screen.queryByTestId('organization-scope-gate')).toBeNull();
    expect(screen.getByRole('tablist', { name: '技能页面切换' })).toBeTruthy();
    expect(screen.getByText('技能内容')).toBeTruthy();
  });
});
