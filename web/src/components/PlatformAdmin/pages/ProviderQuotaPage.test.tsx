import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaHistoryResponse, ProviderQuotaOverviewResponse } from '@agent/shared';

const api = vi.hoisted(() => ({
  providerQuota: vi.fn(),
  providerQuotaHistory: vi.fn(),
  refreshProviderQuota: vi.fn(),
}));

vi.mock('../api', () => ({ platformAdminApi: api }));

import {
  ProviderQuotaPage,
  baselineUsedPercent,
  formatResetIn,
  windowTone,
} from './ProviderQuotaPage';

const overview: ProviderQuotaOverviewResponse = {
  items: [
    {
      sourceKind: 'volcengine_ark_plan',
      accountKey: 'volcengine:ark',
      accountLabel: '火山 Agent Plan',
      groupId: 'ark',
      plan: { type: 'Max', status: 'Running', endTime: '2026-09-09T15:59:59Z', autoRenew: false },
      windows: [
        {
          id: 'five_hour',
          label: '5 小时',
          usedPercent: 0.48,
          used: 241.9,
          quota: 50000,
          unit: 'AFP',
          resetAt: '2026-09-05T11:12:02.000Z',
        },
        {
          id: 'monthly',
          label: '近一月',
          usedPercent: 94.07,
          used: 378005.7,
          quota: 401822.4,
          unit: 'AFP',
          resetAt: '2026-09-06T07:59:59.000Z',
        },
      ],
      limitReached: false,
      ok: true,
      collectedAt: '2026-09-05T06:30:00.000Z',
    },
    {
      sourceKind: 'codex_subscription',
      accountKey: 'codex:c1',
      accountLabel: 'kaiyankeji.3@gmail.com',
      plan: { type: 'pro' },
      windows: [{ id: 'primary', label: '每周', usedPercent: 100, unit: '%', limitReached: true }],
      limitReached: true,
      ok: false,
      error: 'Codex usage HTTP 401',
      collectedAt: '2026-09-05T06:30:00.000Z',
      extra: {
        lastSuccessAt: '2026-09-05T06:25:00.000Z',
        credits: { balance: '0', hasCredits: false, unlimited: false },
      },
    },
  ],
  collector: {
    enabled: true,
    intervalMs: 300_000,
    lastRunAt: '2026-09-05T06:30:00.000Z',
    lastError: 'kaiyankeji.3@gmail.com: Codex usage HTTP 401',
  },
  generatedAt: '2026-09-05T06:31:00.000Z',
};

const history: ProviderQuotaHistoryResponse = {
  hours: 24,
  points: [
    {
      accountKey: 'volcengine:ark',
      collectedAt: '2026-09-04T06:30:00.000Z',
      ok: true,
      windows: [{ id: 'monthly', usedPercent: 90 }],
    },
    {
      accountKey: 'volcengine:ark',
      collectedAt: '2026-09-05T06:30:00.000Z',
      ok: true,
      windows: [{ id: 'monthly', usedPercent: 94.07 }],
    },
  ],
  generatedAt: '2026-09-05T06:31:00.000Z',
};

describe('ProviderQuotaPage', () => {
  beforeEach(() => {
    api.providerQuota.mockReset().mockResolvedValue(overview);
    api.providerQuotaHistory.mockReset().mockResolvedValue(history);
    api.refreshProviderQuota.mockReset().mockResolvedValue(overview);
  });

  it('按账号渲染窗口进度、撞限标记、失败原因与采集器状态', async () => {
    render(<ProviderQuotaPage />);
    await waitFor(() => expect(screen.getByTestId('quota-account-volcengine:ark')).toBeTruthy());
    expect(screen.getByText('kaiyankeji.3@gmail.com')).toBeTruthy();
    expect(screen.getByText('94.1%')).toBeTruthy();
    expect(screen.getByText('接近上限')).toBeTruthy();
    expect(screen.getAllByText('已撞限').length).toBeGreaterThan(0);
    expect(screen.getByText(/Codex usage HTTP 401。下方为/u)).toBeTruthy();
    expect(screen.getByText(/每 5 分钟自动采集/u)).toBeTruthy();
    expect(screen.getByText(/1 个账号已撞限/u)).toBeTruthy();
    // 24h 变化来自 history 的最早成功点
    expect(screen.getByText(/24h \+4\.1%/u)).toBeTruthy();
    expect(api.providerQuotaHistory).toHaveBeenCalledWith(24);
  });

  it('「立即采集」走 refresh 接口并刷新页面', async () => {
    render(<ProviderQuotaPage />);
    await waitFor(() => expect(screen.getByTestId('quota-account-volcengine:ark')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /立即采集/u }));
    await waitFor(() => expect(api.refreshProviderQuota).toHaveBeenCalledTimes(1));
    expect(api.providerQuota).toHaveBeenCalledTimes(1);
  });

  it('没有任何数据源时给出配置指引', async () => {
    api.providerQuota.mockResolvedValue({ ...overview, items: [] });
    render(<ProviderQuotaPage />);
    await waitFor(() => expect(screen.getByText('尚未配置任何套餐用量来源')).toBeTruthy());
  });

  it('接口失败时显示错误而不是空白', async () => {
    api.providerQuota.mockRejectedValue(
      new Error('套餐额度采集未启用：需要 PG runtime event store'),
    );
    render(<ProviderQuotaPage />);
    await waitFor(() => expect(screen.getByText(/套餐额度采集未启用/u)).toBeTruthy());
  });
});

describe('helpers', () => {
  it('windowTone：≥85 提醒，撞限或 ≥100 告警', () => {
    expect(windowTone({ usedPercent: 10 })).toBe('ok');
    expect(windowTone({ usedPercent: 85 })).toBe('warning');
    expect(windowTone({ usedPercent: 99, limitReached: true })).toBe('critical');
    expect(windowTone({ usedPercent: 100 })).toBe('critical');
  });

  it('formatResetIn：分钟/小时/天三档，过期为即将重置', () => {
    const now = Date.parse('2026-09-05T06:00:00Z');
    expect(formatResetIn(undefined, now)).toBeNull();
    expect(formatResetIn('2026-09-05T05:00:00Z', now)).toBe('即将重置');
    expect(formatResetIn('2026-09-05T06:30:00Z', now)).toBe('30 分钟后重置');
    expect(formatResetIn('2026-09-05T09:15:00Z', now)).toBe('3 小时 15 分后重置');
    expect(formatResetIn('2026-09-10T06:00:00Z', now)).toBe('5 天后重置');
  });

  it('baselineUsedPercent 只取该账号该窗口最早的成功点', () => {
    expect(baselineUsedPercent(history.points, 'volcengine:ark', 'monthly')).toBe(90);
    expect(baselineUsedPercent(history.points, 'volcengine:ark', 'weekly')).toBeNull();
    expect(baselineUsedPercent(history.points, 'codex:c1', 'primary')).toBeNull();
  });
});
