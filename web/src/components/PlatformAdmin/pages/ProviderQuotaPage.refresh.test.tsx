import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaOverviewResponse } from '@agent/shared';

const api = vi.hoisted(() => ({
  providerQuota: vi.fn(),
  providerQuotaHistory: vi.fn(),
  refreshProviderQuota: vi.fn(),
}));
vi.mock('../api', () => ({ platformAdminApi: api }));

import { ProviderQuotaPage } from './ProviderQuotaPage';
import { PROVIDER_QUOTA_ORDER_STORAGE_KEY } from './providerQuotaOrder';

function overview(usedPercent = 10): ProviderQuotaOverviewResponse {
  return {
    items: [
      {
        sourceKind: 'volcengine_ark_plan', accountKey: 'volcengine:test', accountLabel: '火山测试账号',
        windows: [
          { id: 'monthly', label: '近一月', usedPercent },
          { id: 'weekly', label: '近一周', usedPercent: 5 },
          { id: 'daily', label: '近一天', usedPercent: 2 },
        ],
        ok: true, limitReached: false, collectedAt: '2026-09-11T08:00:45Z',
      },
      {
        sourceKind: 'claude_subscription', accountKey: 'claude:test', accountLabel: 'Claude 测试账号',
        windows: [
          { id: 'seven_day', label: '7 天', usedPercent: usedPercent + 1 },
          { id: 'five_hour', label: '5 小时', usedPercent: 3 },
        ],
        ok: true, limitReached: false, collectedAt: '2026-09-11T08:00:45Z',
      },
    ],
    collector: { enabled: true, intervalMs: 300_000, lastRunAt: null, lastError: null },
    generatedAt: '2026-09-11T08:00:45Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let visibility: DocumentVisibilityState;

beforeEach(() => {
  window.localStorage.clear();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  api.providerQuota.mockReset().mockResolvedValue(overview());
  api.providerQuotaHistory.mockReset().mockResolvedValue({ hours: 24, points: [], generatedAt: overview().generatedAt });
  api.refreshProviderQuota.mockReset().mockResolvedValue(overview());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

async function ready() {
  await screen.findByTestId('quota-account-volcengine:test');
  await waitFor(() => expect(screen.getByRole('button', { name: /^刷新$/u }).hasAttribute('disabled')).toBe(false));
}

function returnToTab() {
  visibility = 'hidden';
  fireEvent(document, new Event('visibilitychange'));
  visibility = 'visible';
  fireEvent(document, new Event('visibilitychange'));
  fireEvent.focus(window);
}

describe('ProviderQuotaPage snapshot refresh', () => {
  it('刷新在立即采集左侧且两者无图标；只读取快照，保留卡片、排序和展开状态', async () => {
    const order = ['volcengine:test', 'claude:test'];
    window.localStorage.setItem(PROVIDER_QUOTA_ORDER_STORAGE_KEY, JSON.stringify(order));
    render(<ProviderQuotaPage />);
    await ready();
    const card = screen.getByTestId('quota-account-volcengine:test');
    const details = within(card).getByText('其他（1 个窗口）').closest('details')!;
    fireEvent.click(details.querySelector('summary')!);
    const refresh = screen.getByRole('button', { name: /^刷新$/u });
    const collect = screen.getByRole('button', { name: '立即采集' });
    expect(refresh.nextElementSibling).toBe(collect);
    expect(refresh.querySelector('svg')).toBeNull();
    expect(collect.querySelector('svg')).toBeNull();
    api.providerQuota.mockResolvedValue(overview(45));
    fireEvent.click(refresh);
    await waitFor(() => expect(screen.getByTestId('quota-window-monthly').textContent).toContain('45.0%'));
    expect(screen.getByTestId('quota-window-seven_day').textContent).toContain('46.0%');
    expect(api.providerQuota).toHaveBeenCalledTimes(2);
    expect(api.providerQuotaHistory).toHaveBeenCalledTimes(2);
    expect(api.refreshProviderQuota).not.toHaveBeenCalled();
    expect(screen.getByTestId('quota-account-volcengine:test')).toBe(card);
    expect(details.open).toBe(true);
    expect(screen.getAllByTestId(/^quota-account-/).map((node) => node.dataset.testid))
      .toEqual(order.map((key) => `quota-account-${key}`));
    expect(JSON.parse(window.localStorage.getItem(PROVIDER_QUOTA_ORDER_STORAGE_KEY)!)).toEqual(order);
  });

  it('每次返回标签页或浏览器窗口自动读取，后台不读取，同一次前台切换不重复请求', async () => {
    render(<ProviderQuotaPage />);
    await ready();
    visibility = 'hidden';
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.focus(window);
    expect(api.providerQuota).toHaveBeenCalledTimes(1);
    visibility = 'visible';
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.focus(window);
    await ready();
    expect(api.providerQuota).toHaveBeenCalledTimes(2);
    // 重复通知即使发生在请求已完成后，也不是一次新的前台切换。
    fireEvent.focus(window);
    fireEvent(document, new Event('visibilitychange'));
    expect(api.providerQuota).toHaveBeenCalledTimes(2);
    fireEvent.blur(window);
    fireEvent.focus(window);
    await ready();
    expect(api.providerQuota).toHaveBeenCalledTimes(3);
    returnToTab();
    await ready();
    expect(api.providerQuota).toHaveBeenCalledTimes(4);
    expect(api.refreshProviderQuota).not.toHaveBeenCalled();
  });

  it('采集期间禁用读取和采集操作，多次前台切换合并为采集完成后的一次读取', async () => {
    render(<ProviderQuotaPage />);
    await ready();
    const collection = deferred<ProviderQuotaOverviewResponse>();
    api.refreshProviderQuota.mockReturnValueOnce(collection.promise);
    api.providerQuota.mockResolvedValue(overview(50));
    fireEvent.click(screen.getByRole('button', { name: '立即采集' }));
    expect(screen.getByRole('button', { name: /^刷新$/u }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '立即采集' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('button', { name: '刷新 火山测试账号' }).hasAttribute('disabled')).toBe(true);
    returnToTab();
    returnToTab();
    fireEvent.click(screen.getByRole('button', { name: /^刷新$/u }));
    expect(api.providerQuota).toHaveBeenCalledTimes(1);
    expect(api.refreshProviderQuota).toHaveBeenCalledTimes(1);
    expect(api.refreshProviderQuota).toHaveBeenCalledWith(undefined);
    await act(async () => { collection.resolve(overview(40)); });
    await ready();
    expect(api.providerQuota).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('quota-window-monthly').textContent).toContain('50.0%');
    expect(screen.getByRole('button', { name: '立即采集' }).getAttribute('aria-busy')).toBe('false');
  });

  it('读取期间禁用重复操作并显示忙碌状态，完成后恢复按钮', async () => {
    render(<ProviderQuotaPage />);
    await ready();
    const reload = deferred<ProviderQuotaOverviewResponse>();
    api.providerQuota.mockReturnValueOnce(reload.promise);
    const refresh = screen.getByRole('button', { name: /^刷新$/u });
    fireEvent.click(refresh);
    expect(refresh.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(refresh);
    fireEvent.click(screen.getByRole('button', { name: '立即采集' }));
    expect(api.providerQuota).toHaveBeenCalledTimes(2);
    expect(api.refreshProviderQuota).not.toHaveBeenCalled();
    await act(async () => { reload.resolve(overview(30)); });
    await ready();
    expect(refresh.getAttribute('aria-busy')).toBe('false');
  });

  it('刷新失败保留旧卡片，显示错误并允许重试成功后清除错误', async () => {
    render(<ProviderQuotaPage />);
    await ready();
    const card = screen.getByTestId('quota-account-volcengine:test');
    api.providerQuota.mockRejectedValueOnce(new Error('快照读取失败'));
    fireEvent.click(screen.getByRole('button', { name: /^刷新$/u }));
    await screen.findByText(/快照读取失败/);
    expect(screen.getByTestId('quota-account-volcengine:test')).toBe(card);
    expect(screen.getByTestId('quota-window-monthly').textContent).toContain('10.0%');
    api.providerQuota.mockResolvedValue(overview(35));
    fireEvent.click(screen.getByRole('button', { name: /^刷新$/u }));
    await waitFor(() => expect(screen.getByTestId('quota-window-monthly').textContent).toContain('35.0%'));
    expect(screen.queryByText(/快照读取失败/)).toBeNull();
  });

  it('卸载后移除前台监听，不应用旧请求或启动已排队的读取', async () => {
    const view = render(<ProviderQuotaPage />);
    await ready();
    const reload = deferred<ProviderQuotaOverviewResponse>();
    api.providerQuota.mockReturnValueOnce(reload.promise);
    fireEvent.click(screen.getByRole('button', { name: /^刷新$/u }));
    returnToTab();
    view.unmount();
    await act(async () => { reload.resolve(overview(99)); });
    returnToTab();
    fireEvent.blur(window);
    fireEvent.focus(window);
    expect(api.providerQuota).toHaveBeenCalledTimes(2);
    expect(api.refreshProviderQuota).not.toHaveBeenCalled();
  });

  it('StrictMode 重建忽略上一轮较晚完成的请求，不覆盖当前快照', async () => {
    const oldRequest = deferred<ProviderQuotaOverviewResponse>();
    api.providerQuota.mockReturnValueOnce(oldRequest.promise).mockResolvedValue(overview(25));
    render(<StrictMode><ProviderQuotaPage /></StrictMode>);
    await ready();
    expect(api.providerQuota).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('quota-window-monthly').textContent).toContain('25.0%');
    await act(async () => { oldRequest.resolve(overview(99)); });
    expect(screen.getByTestId('quota-window-monthly').textContent).toContain('25.0%');
    returnToTab();
    await ready();
    expect(api.providerQuota).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['codex_subscription', 'primary'],
    ['claude_subscription', 'seven_day'],
    ['volcengine_ark_plan', 'monthly'],
    ['zhipu_coding_plan', 'tokens_limit:3:5'],
  ] as const)('%s 的进度条上方重置时间与采集时间都不显示秒数', async (sourceKind, id) => {
    const data = overview();
    api.providerQuota.mockResolvedValue({
      ...data,
      items: [{
        ...data.items[0]!, sourceKind,
        windows: [{ id, label: '测试窗口', usedPercent: 12, resetAt: '2026-09-10T12:34:56' }],
      }],
    });
    render(<ProviderQuotaPage />);
    const card = await screen.findByTestId('quota-account-volcengine:test');
    const tile = within(card).getByTestId(`quota-window-${id}`);
    expect(tile.textContent).toContain('09/10 周四 12:34');
    expect(tile.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(within(card).getByText(/^采集 /).textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});
