import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authFetch = vi.fn();
vi.mock('@/lib/authFetch', () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }));

import { KyAppDeliveryHealthPanel, KyAppTenantUsagePanel } from './KyAppDeliveryPanels';
import type { UsageOverview } from '@/lib/kyAppUsageOverview';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function overview(overrides: Partial<UsageOverview> = {}): UsageOverview {
  return {
    currentMonthCreditsUsed: 100,
    balanceCredits: 20,
    estimatedDaysRemaining: 2,
    topUsers: [{ userId: 'u1', name: '张三', creditsUsed: 80 }],
    topCapabilities: [{ capabilityId: 'order.search', calls: 6 }],
    weeklyTrend: [{ date: '2026-09-07', creditsUsed: 10 }],
    capabilityMetric: 'call_count',
    ...overrides,
  };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('KY App 交付看板', () => {
  beforeEach(() => authFetch.mockReset());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('客户概览展示真实口径与三天预警', async () => {
    authFetch.mockResolvedValueOnce(json({ overview: overview() }));
    render(<KyAppTenantUsagePanel tenantId="tenant-a" />);
    expect(await screen.findByText('order.search')).toBeTruthy();
    expect(screen.getByText('AI 使用概览')).toBeTruthy();
    expect(screen.getByText(/预计还能使用 2 天/)).toBeTruthy();
    expect(screen.queryByText('加载 AI 使用概览')).toBeNull();
    expect(authFetch).toHaveBeenCalledWith(
      '/api/app-contract/v1/usage?tenantId=tenant-a',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('实例用量使用独立且正确编码的接口', async () => {
    authFetch.mockResolvedValueOnce(json({ overview: overview() }));
    render(<KyAppTenantUsagePanel tenantId="tenant-a" installationId="iid/one" />);
    expect(await screen.findByText('order.search')).toBeTruthy();
    expect(authFetch).toHaveBeenCalledWith(
      '/api/app-contract/v1/installations/iid%2Fone/usage',
      expect.anything(),
    );
  });

  it('真实零用量正常展示空态而不是继续加载', async () => {
    authFetch.mockResolvedValueOnce(
      json({
        overview: overview({
          currentMonthCreditsUsed: 0,
          balanceCredits: 0,
          estimatedDaysRemaining: null,
          topUsers: [],
          topCapabilities: [],
          weeklyTrend: [],
        }),
      }),
    );
    render(<KyAppTenantUsagePanel tenantId="tenant-a" />);
    expect(await screen.findByText('本月暂无消耗')).toBeTruthy();
    expect(screen.getByText('本月暂无能力调用')).toBeTruthy();
    expect(screen.getByText('数据不足')).toBeTruthy();
    expect(screen.getByText(/AI 积分已用完/)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each([
    { name: 'missing overview', body: {} },
    { name: 'null overview', body: { overview: null } },
    { name: 'missing metrics', body: { overview: {} } },
    { name: 'invalid balance', body: { overview: { ...overview(), balanceCredits: '20' } } },
    { name: 'missing top users', body: { overview: { ...overview(), topUsers: null } } },
    { name: 'invalid capability', body: { overview: { ...overview(), topCapabilities: [null] } } },
    { name: 'invalid trend', body: { overview: { ...overview(), weeklyTrend: [{ date: null }] } } },
  ])('已完成但无效的响应展示可重试错误：$name', async ({ body }) => {
    authFetch.mockResolvedValueOnce(json(body));
    render(<KyAppTenantUsagePanel tenantId="tenant-a" />);
    expect((await screen.findByRole('alert')).textContent).toContain('数据格式异常');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.queryByText('加载 AI 使用概览')).toBeNull();
    expect(screen.queryByText('本月消耗')).toBeNull();
  });

  it('HTTP 200 HTML 不再无限加载，重试后可恢复真实用量', async () => {
    authFetch
      .mockResolvedValueOnce(new Response('<html>SPA fallback</html>', { status: 200 }))
      .mockResolvedValueOnce(json({ overview: overview() }));
    render(<KyAppTenantUsagePanel tenantId="tenant-a" />);
    expect((await screen.findByRole('alert')).textContent).toContain('未返回有效 JSON');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('order.search')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(authFetch).toHaveBeenCalledTimes(2);
  });

  it('服务未启用时显示后端原因，而不是空白或伪造零值', async () => {
    authFetch.mockResolvedValueOnce(
      json({ error: { code: 'unavailable', message: '业务系统接入功能尚未启用' } }, 503),
    );
    render(<KyAppTenantUsagePanel tenantId="tenant-a" />);
    expect((await screen.findByRole('alert')).textContent).toContain('业务系统接入功能尚未启用');
    expect(screen.getByText('AI 使用概览')).toBeTruthy();
    expect(screen.queryByText('本月消耗')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('挂起请求在 30 秒后可重试，迟到响应不能覆盖超时状态', async () => {
    vi.useFakeTimers();
    const pending = deferredResponse();
    authFetch.mockReturnValueOnce(pending.promise);
    render(<KyAppTenantUsagePanel tenantId="tenant-a" />);
    expect(screen.getByRole('status').textContent).toContain('加载 AI 使用概览');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByRole('alert').textContent).toContain('请求超时');
    expect(authFetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
    vi.useRealTimers();
    await act(async () => pending.resolve(json({ overview: overview() })));
    expect(screen.queryByText('order.search')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('请求超时');
    authFetch.mockResolvedValueOnce(json({ overview: overview() }));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('order.search')).toBeTruthy();
  });

  it('切换组织立即隐藏旧数据，刷新期间有独立的加载状态', async () => {
    const pending = deferredResponse();
    authFetch
      .mockResolvedValueOnce(json({ overview: overview() }))
      .mockReturnValueOnce(pending.promise);
    const { rerender } = render(<KyAppTenantUsagePanel tenantId="tenant-a" />);
    expect(await screen.findByText('张三')).toBeTruthy();
    rerender(<KyAppTenantUsagePanel tenantId="tenant-b" />);
    expect(screen.queryByText('张三')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
    await act(async () => pending.resolve(json({ overview: overview({ topUsers: [] }) })));
    expect(await screen.findByText('本月暂无消耗')).toBeTruthy();
    const refresh = deferredResponse();
    authFetch.mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(screen.getByRole('status')).toBeTruthy();
    expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => refresh.resolve(json({ overview: overview({ topUsers: [] }) })));
    expect(await screen.findByText('本月暂无消耗')).toBeTruthy();
  });

  it('切换组织会取消旧请求并忽略它的迟到结果', async () => {
    const old = deferredResponse();
    authFetch
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(json({ overview: overview({ topUsers: [] }) }));
    const { rerender } = render(<KyAppTenantUsagePanel tenantId="tenant-a" />);
    rerender(<KyAppTenantUsagePanel tenantId="tenant-b" />);
    expect(authFetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(await screen.findByText('本月暂无消耗')).toBeTruthy();
    await act(async () => old.resolve(json({ overview: overview() })));
    expect(screen.queryByText('张三')).toBeNull();
  });

  it('卸载会取消请求并清理超时计时器', () => {
    vi.useFakeTimers();
    authFetch.mockReturnValueOnce(deferredResponse().promise);
    const { unmount } = render(<KyAppTenantUsagePanel tenantId="tenant-a" />);
    unmount();
    expect(authFetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('平台健康度展示组织与来源说明', async () => {
    authFetch.mockResolvedValueOnce(
      json({
        items: [
          {
            installationId: 'iid-1',
            tenantId: 't1',
            tenantName: '客户甲',
            systemId: 'erp',
            deliveredAt: '2026-09-01T00:00:00Z',
            loginPenetration: 0.5,
            weeklyActiveAskers: 3,
            consumptionRate: 0.2,
            estimatedDaysRemaining: 8,
            lastUsageAt: null,
            offboardingStatus: 'active',
          },
        ],
      }),
    );
    render(<KyAppDeliveryHealthPanel />);
    expect(await screen.findByText('客户甲')).toBeTruthy();
    expect(screen.getByText('3 人')).toBeTruthy();
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        '/api/app-contract/v1/deliveries/health',
        expect.objectContaining({ cache: 'no-store' }),
      ),
    );
  });
});
