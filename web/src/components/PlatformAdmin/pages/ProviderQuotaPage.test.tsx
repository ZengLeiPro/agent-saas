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
  accountStatus,
  baselineUsedPercent,
  formatResetIn,
  formatWan,
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
      resetCredits: 2,
      credential: {
        expiresAt: '2026-09-14T06:22:10.000Z',
        availability: 'quota_cooldown',
        cooldownUntil: '2026-09-05T07:30:00.000Z',
        lastFailureCode: 'usage_limit_reached',
      },
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

  it('按账号渲染状态徽标、剩余额度瓷片、凭据事实与采集器状态', async () => {
    render(<ProviderQuotaPage />);
    await waitFor(() => expect(screen.getByTestId('quota-account-volcengine:ark')).toBeTruthy());
    // 卡级状态：火山接近上限（月度 94%），Codex 采集失败
    expect(screen.getAllByText('接近上限').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('采集失败')).toBeTruthy();
    // 大数字是剩余百分比；用量用「万」表达
    expect(screen.getByText('5.9%')).toBeTruthy();
    expect(screen.getByText(/已用 37\.8万 \/ 40\.2万 AFP/u)).toBeTruthy();
    expect(screen.getByText(/已用 100\.0% · 仅提供百分比/u)).toBeTruthy();
    // Codex 事实栅格：重置券、凭据到期、调度状态
    expect(screen.getByText('2 张')).toBeTruthy();
    expect(screen.getByText('凭据到期')).toBeTruthy();
    expect(screen.getByText(/^冷却中，至 /u)).toBeTruthy();
    // 失败原因 + 上次成功数据提示
    expect(screen.getByText(/Codex usage HTTP 401。下方为/u)).toBeTruthy();
    // 顶部汇总
    expect(screen.getByText(/每 5 分钟自动采集/u)).toBeTruthy();
    expect(screen.getByText(/1 个账号采集失败/u)).toBeTruthy();
    expect(screen.queryByText(/已耗尽或不可用/u)).toBeNull();
    expect(screen.getByText(/1 个账号接近上限或冷却中/u)).toBeTruthy();
    // 24h 变化来自 history 的最早成功点
    expect(screen.getByText(/24h \+4\.1%/u)).toBeTruthy();
    // 火山口径脚注
    expect(screen.getByText(/不计入 5 小时 \/ 周额度限制/u)).toBeTruthy();
    expect(api.providerQuotaHistory).toHaveBeenCalledWith(24);
  });

  it('「立即采集」全量刷新，卡上的刷新按钮只刷该账号', async () => {
    render(<ProviderQuotaPage />);
    await waitFor(() => expect(screen.getByTestId('quota-account-volcengine:ark')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /立即采集/u }));
    await waitFor(() => expect(api.refreshProviderQuota).toHaveBeenCalledWith(undefined));
    fireEvent.click(screen.getByRole('button', { name: '刷新 kaiyankeji.3@gmail.com' }));
    await waitFor(() => expect(api.refreshProviderQuota).toHaveBeenCalledWith('codex:c1'));
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

  it('accountStatus：采集失败 > 凭据不可用 > 已耗尽 > 冷却中 > 接近上限 > 正常', () => {
    const okWindow = { id: 'w', label: 'w', usedPercent: 10 };
    expect(accountStatus({ ok: false, limitReached: false, windows: [] })).toEqual({ tone: 'critical', label: '采集失败' });
    expect(accountStatus({ ok: true, limitReached: false, windows: [okWindow], credential: { availability: 'auth_unavailable' } }).label).toBe('凭据不可用');
    expect(accountStatus({ ok: true, limitReached: true, windows: [okWindow], credential: { availability: 'quota_cooldown' } }).label).toBe('已耗尽');
    expect(accountStatus({ ok: true, limitReached: false, windows: [okWindow], credential: { availability: 'quota_cooldown' } })).toEqual({ tone: 'warning', label: '冷却中' });
    expect(accountStatus({ ok: true, limitReached: false, windows: [{ ...okWindow, usedPercent: 90 }] }).label).toBe('接近上限');
    expect(accountStatus({ ok: true, limitReached: false, windows: [okWindow] })).toEqual({ tone: 'ok', label: '正常' });
  });

  it('formatWan：万/亿量级与小数位', () => {
    expect(formatWan(378005.7)).toBe('37.8万');
    expect(formatWan(1_398.957)).toBe('1,399');
    expect(formatWan(50_000)).toBe('5.0万');
    expect(formatWan(2_500_000)).toBe('250万');
    expect(formatWan(123_456_789)).toBe('1.23亿');
    expect(formatWan(0.6)).toBe('0.6');
    expect(formatWan(0)).toBe('0');
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
