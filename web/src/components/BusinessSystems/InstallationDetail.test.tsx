import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InstallationDetail } from './InstallationDetail';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  reload: vi.fn(),
  loadMySystems: vi.fn(),
}));

vi.mock('@/lib/kyAppManagementApi', () => ({
  installationPath: (id: string, suffix: string) => `/installations/${id}${suffix}`,
  kyAppPost: mocks.post,
}));
vi.mock('@/lib/mySystemsSource', () => ({ loadMySystems: mocks.loadMySystems }));
vi.mock('./ManagementResource', () => ({
  useManagementResource: () => ({
    data: {
      installation: {
        installationId: 'iid-1',
        tenantId: 'tenant-a',
        systemId: 'erp',
        domainVerifiedAt: '2026-09-09T00:00:00.000Z',
        registeredDigest: 'a'.repeat(64),
      },
      definition: { name: '业务系统' },
      readiness: {
        overallStatus: 'ready',
        pageStatus: 'available',
        agentStatus: 'ready',
        personalAuthorizationMode: 'not_required',
      },
      upgrade: { currentDigest: 'a'.repeat(64), publishedDigest: 'a'.repeat(64) },
      allowedActions: ['disable', 'verify_domain', 'edit_assignments'],
    },
    reload: mocks.reload,
    error: '',
  }),
  ResourceState: () => null,
}));
vi.mock('./InstallationRuntime', () => ({ InstallationRuntime: () => <div>服务健康</div> }));
vi.mock('./InstallationActivity', () => ({ InstallationActivity: () => <div>调用情况</div> }));
vi.mock('./InstallationAssignments', () => ({
  InstallationAssignments: () => <div>规则编辑器</div>,
}));
vi.mock('./InstallationAccessOverview', () => ({
  InstallationAccessOverview: () => <div>成员授权</div>,
}));

describe('业务系统实例详情', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.post.mockResolvedValue({
      result: { verified: true, method: 'dns_txt', detail: 'DNS TXT 记录匹配' },
    });
  });

  it('使用站内对话框执行真实域名复验并展示后端结果', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
    render(
      <InstallationDetail installationId="iid-1" tenantId="tenant-a" onBack={() => undefined} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '重新验证业务域名' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/实时查询业务域名的 DNS TXT 记录/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '开始验证' }));

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/installations/iid-1/verify-domain'),
    );
    expect(await screen.findByText('业务域名验证通过：DNS TXT 记录匹配')).toBeTruthy();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('不再展示无法理解的高级操作入口', () => {
    render(
      <InstallationDetail installationId="iid-1" tenantId="tenant-a" onBack={() => undefined} />,
    );
    expect(screen.queryByText('高级操作')).toBeNull();
  });
});
