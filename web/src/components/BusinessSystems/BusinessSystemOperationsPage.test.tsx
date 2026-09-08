import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessSystemOperationsPage } from './BusinessSystemOperationsPage';

const authFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authFetch', () => ({ authFetch }));
vi.mock('@/lib/urlSync', () => ({ navigateGovernance: vi.fn() }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  authFetch.mockReset();
});

describe('业务系统运营可用状态', () => {
  it.each([undefined, 'iid-1'])(
    '服务关闭时不请求列表、健康概览或详情 (%s)',
    async (installationId) => {
      authFetch.mockImplementation(async () => json({ enabled: false }));
      render(<BusinessSystemOperationsPage installationId={installationId} />);
      expect(
        await screen.findByText('业务系统服务未启用或尚未就绪，暂时无法查看运营数据。'),
      ).toBeTruthy();
      expect(authFetch.mock.calls.map(([path]) => path)).toEqual([
        '/api/app-contract/v1/availability',
      ]);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    },
  );

  it('刷新确认服务启用后加载运营数据，并支持筛选', async () => {
    let enabled = false;
    authFetch.mockImplementation(async (path: string) => {
      if (path.endsWith('/availability')) return json({ enabled });
      if (path.includes('/installations?')) return json({ installations: [], nextCursor: null });
      if (path.endsWith('/deliveries/health')) return json({ items: [] });
      throw new Error(`unexpected path ${path}`);
    });
    render(<BusinessSystemOperationsPage />);
    const refresh = await screen.findByRole('button', { name: '刷新状态' });
    enabled = true;
    fireEvent.click(refresh);
    expect(await screen.findByText('暂无符合条件的安装实例')).toBeTruthy();
    expect(await screen.findByText('暂无符合条件的交付记录')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('组织标识'), { target: { value: 'tenant-a' } });
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        '/api/app-contract/v1/installations?tenantId=tenant-a',
        expect.anything(),
      ),
    );
  });

  it('状态查询失败保留真实错误和重试，不推断为未启用', async () => {
    authFetch.mockResolvedValueOnce(json({ error: { message: '状态查询失败' } }, 503));
    render(<BusinessSystemOperationsPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('状态查询失败')).toBeTruthy();
    expect(screen.queryByText(/业务系统服务未启用/)).toBeNull();
    authFetch.mockResolvedValueOnce(json({ enabled: false }));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('button', { name: '刷新状态' })).toBeTruthy();
  });

  it('已启用时仍展示业务接口的真实 404', async () => {
    authFetch.mockImplementation(async (path: string) => {
      if (path.endsWith('/availability')) return json({ enabled: true });
      if (path.endsWith('/deliveries/health')) return json({ items: [] });
      return json(null, 404);
    });
    render(<BusinessSystemOperationsPage />);
    expect(await screen.findByText('请求失败 (404)')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.queryByText(/业务系统服务未启用/)).toBeNull();
  });
});
