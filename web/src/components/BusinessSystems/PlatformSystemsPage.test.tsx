import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kyAppRequest } from '@/lib/kyAppManagementApi';
import { navigateGovernance } from '@/lib/urlSync';
import { PlatformSystemsPage } from './PlatformSystemsPage';
import { LegacySystemDeliveryPage } from '../SystemDelivery/SystemDeliveryPage';
vi.mock('@/lib/kyAppManagementApi', async (original) => ({
  ...(await original<object>()),
  kyAppRequest: vi.fn(),
}));
vi.mock('@/lib/urlSync', () => ({ navigateGovernance: vi.fn() }));
const execution = {
  executionId: 'run-demo',
  tenantId: 'tenant-a',
  tenantName: '中文组织',
  systemId: 'demo',
  status: 'waiting_external',
  request: { mode: 'existing' },
  steps: [
    { id: 'existing_organization', status: 'completed' },
    { id: 'installation_credential', status: 'completed' },
    { id: 'enable', status: 'completed' },
    { id: 'assignments', status: 'completed' },
    { id: 'smoke', status: 'pending' },
    { id: 'delivery_checklist', status: 'pending' },
  ],
};
beforeEach(() => {
  window.history.replaceState({}, '', '/platform-console/resource-center/business-systems/demo');
  vi.mocked(kyAppRequest).mockImplementation(async (path) => {
    if (path === '/systems/demo')
      return {
        definition: {
          systemId: 'demo',
          name: '演示系统',
          status: 'published',
          version: 1,
          publishedDigest: 'a'.repeat(64),
        },
        versions: [
          {
            digest: 'b'.repeat(64),
            status: 'draft',
            reviewStatus: 'not_required',
            reviewReasons: [],
            createdBy: 'admin',
            allowedActions: ['publish_version'],
            manifest: {
              capabilities: [
                {
                  id: 'user.search',
                  name: '查询用户',
                  description: '按条件查询组织成员',
                  riskLevel: 'read_only',
                },
              ],
            },
          },
        ],
        metrics: { capabilityCount: 1, externalWriteCapabilityCount: 0, installationCount: 1 },
        allowedActions: ['register_version'],
      } as never;
    if (path === '/systems') return { systems: [] } as never;
    if (path === '/systems/demo/connection-options')
      return {
        settings: { baseUrl: '', origin: '' },
        version: 1,
        published: true,
        publishedDigest: 'a'.repeat(64),
        organizations: [
          {
            id: 'tenant-a',
            name: '中文组织',
            connection: {
              installationId: 'installation-a',
              status: 'enabled',
              executionId: 'run-demo',
              ready: true,
            },
          },
        ],
      } as never;
    if (path === '/deliveries')
      return {
        executions: [
          execution,
          { ...execution, executionId: 'other', systemId: 'other', tenantId: 'other-tenant' },
        ],
      } as never;
    if (path === '/onboard/run-demo') return { execution } as never;
    throw new Error(`unexpected path ${path}`);
  });
});
afterEach(() => vi.clearAllMocks());
describe('业务系统统一入口', () => {
  it('发布入口常显，登记只在自定义弹窗中出现，能力列表可展开', async () => {
    render(<PlatformSystemsPage systemId="demo" />);
    await screen.findByText('演示系统');
    expect(screen.getByRole('button', { name: '发布版本' })).toBeTruthy();
    expect(screen.queryByLabelText('Manifest JSON 文件')).toBeNull();
    fireEvent.click(screen.getByText('历史版本与高级信息'));
    expect(screen.queryByLabelText('Manifest JSON 文件')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看全部能力' }));
    expect(screen.getByText('查询用户')).toBeTruthy();
    expect(screen.getByText('按条件查询组织成员')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '登记新版本' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByLabelText('Manifest JSON 文件')).toBeTruthy();
  });

  it('同页管理版本和组织接入，只显示本系统记录，切换页签保留接入进度', async () => {
    render(<PlatformSystemsPage systemId="demo" />);
    await screen.findByText('演示系统');
    expect(screen.getByRole('tab', { name: '系统配置' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.mouseDown(screen.getByRole('tab', { name: '组织接入' }), {
      button: 0,
      ctrlKey: false,
    });
    await screen.findByText('组织 中文组织 · 已完成');
    expect(screen.queryByText('组织 other-tenant · 处理中')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看进度' }));
    await screen.findByRole('button', { name: '刷新进度' });
    expect(new URLSearchParams(location.search).get('execution')).toBe('run-demo');
    fireEvent.mouseDown(screen.getByRole('tab', { name: '系统配置' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.mouseDown(screen.getByRole('tab', { name: '组织接入' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByRole('button', { name: '返回组织接入' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回组织接入' }));
    await screen.findByText('组织 中文组织 · 已完成');
    expect(new URLSearchParams(location.search).has('execution')).toBe(false);
  });

  it('核心接入完成后不再展示可选验收步骤或等待外部处理', async () => {
    window.history.replaceState(
      {},
      '',
      '/platform-console/resource-center/business-systems/demo?tab=installations&execution=run-demo',
    );
    render(<PlatformSystemsPage systemId="demo" />);
    await screen.findByText('组织 中文组织 · 已完成');
    expect(screen.queryByText('业务验收')).toBeNull();
    expect(screen.queryByText('交付清单')).toBeNull();
    expect(screen.queryByText('等待完成外部处理。完成后可继续原接入请求。')).toBeNull();
    expect(screen.queryByRole('button', { name: '继续交付' })).toBeNull();
    expect(screen.getByRole('button', { name: '进入组织授权' })).toBeTruthy();
  });
  it('旧交付详情链接跳转到所属系统，保留执行标识', async () => {
    render(<LegacySystemDeliveryPage executionId="run-demo" />);
    await waitFor(() => expect(navigateGovernance).toHaveBeenCalled());
    expect(vi.mocked(navigateGovernance).mock.calls[0]?.[0]).toMatchObject({
      routeId: 'platform.resource-center.business-systems',
      entityId: 'demo',
      search: '?tab=installations&execution=run-demo',
    });
  });
});
