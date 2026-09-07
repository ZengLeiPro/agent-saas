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
  systemId: 'demo',
  status: 'running',
  steps: [],
};
beforeEach(() => {
  window.history.replaceState({}, '', '/platform-console/resource-center/business-systems/demo');
  vi.mocked(kyAppRequest).mockImplementation(async (path) => {
    if (path === '/systems/demo')
      return {
        definition: { systemId: 'demo', name: '演示系统', version: 1 },
        versions: [],
        allowedActions: [],
      } as never;
    if (path === '/systems') return { systems: [] } as never;
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
  it('同页管理版本和组织接入，只显示本系统记录，切换页签保留接入进度', async () => {
    render(<PlatformSystemsPage systemId="demo" />);
    await screen.findByText('演示系统');
    expect(screen.getByRole('tab', { name: '版本管理' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('tab', { name: '组织接入' }));
    await screen.findByText('demo · tenant-a · running');
    expect(screen.queryByText('other · other-tenant · running')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看进度' }));
    await screen.findByRole('button', { name: '刷新进度' });
    expect(new URLSearchParams(location.search).get('execution')).toBe('run-demo');
    fireEvent.click(screen.getByRole('tab', { name: '版本管理' }));
    fireEvent.click(screen.getByRole('tab', { name: '组织接入' }));
    expect(screen.getByRole('button', { name: '返回组织接入' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回组织接入' }));
    await screen.findByText('demo · tenant-a · running');
    expect(new URLSearchParams(location.search).has('execution')).toBe(false);
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
