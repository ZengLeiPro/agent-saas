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

describe('ManagementShell', () => {
  it('统一渲染面包屑、页头和唯一滚动容器', () => {
    render(
      <ManagementShell route={governanceRoute('platform.overview.overview')} access={access}>
        <div>真实内容</div>
      </ManagementShell>,
    );
    expect(screen.getByTestId('management-shell').getAttribute('data-surface')).toBe('analytics');
    expect(screen.getAllByText('平台总览').length).toBeGreaterThan(0);
    expect(screen.getByTestId('management-scroll-container').className).toContain(
      'overflow-y-auto',
    );
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
