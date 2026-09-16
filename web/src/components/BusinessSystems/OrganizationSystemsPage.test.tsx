import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrganizationSystemsPage } from './OrganizationSystemsPage';

const mocks = vi.hoisted(() => ({
  data: { installations: [], nextCursor: null } as {
    installations: Array<Record<string, unknown>>;
    nextCursor: string | null;
  },
  reload: vi.fn(),
}));

vi.mock('./ManagementResource', () => ({
  useManagementResource: () => ({ data: mocks.data, reload: mocks.reload, error: '' }),
  ResourceState: () => null,
}));
vi.mock('@/lib/urlSync', () => ({ navigateGovernance: vi.fn() }));

describe('组织业务系统列表', () => {
  beforeEach(() => {
    mocks.data = { installations: [], nextCursor: null };
    vi.clearAllMocks();
  });

  it('空列表展示有说明和主操作的空状态，不展示无效分页按钮', () => {
    render(<OrganizationSystemsPage tenantId="tenant-a" />);
    expect(screen.getByText('还没有接入业务系统')).toBeTruthy();
    expect(screen.getByText(/统一查看页面、Agent 能力、版本状态和组织授权/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '上一页' })).toBeNull();
    expect(screen.queryByRole('button', { name: '下一页' })).toBeNull();
  });

  it('只显示用户关心的页面、Agent 状态和下一步，不暴露协议版本', () => {
    mocks.data = {
      installations: [
        {
          installationId: 'iid-v2',
          tenantId: 'tenant-a',
          systemId: 'erp',
          systemName: '测试 ERP',
          status: 'enabled',
          authMode: 'v2_asymmetric',
          runtimeStatus: 'healthy',
          registeredDigest: 'a'.repeat(64),
          publishedDigest: 'a'.repeat(64),
          domainVerifiedAt: '2026-09-15T00:00:00.000Z',
          updatedAt: '2026-09-15T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    };
    render(<OrganizationSystemsPage tenantId="tenant-a" />);
    expect(screen.queryByText(/V[12]/)).toBeNull();
    expect(screen.getByText('下一步')).toBeTruthy();
    expect(screen.getByText('页面访问')).toBeTruthy();
    expect(screen.getByText('Agent 能力')).toBeTruthy();
    expect(screen.getByRole('button', { name: /查看系统/ })).toBeTruthy();
  });
});
