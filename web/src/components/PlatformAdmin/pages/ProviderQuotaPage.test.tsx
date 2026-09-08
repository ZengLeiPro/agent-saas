import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  formatResetTime,
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
    expect(screen.getByText('94.1%')).toBeTruthy();
    expect(screen.getByText(/已用 37\.8万 \/ 40\.2万 AFP/u)).toBeTruthy();
    expect(screen.getByText('100.0%')).toBeTruthy();
    // Codex 事实栅格：重置券、凭据到期、调度状态
    expect(screen.getByText('Codex 订阅 · Pro · 重置券 2')).toBeTruthy();
    expect(screen.getByTitle(/^凭据到期 /u)).toBeTruthy();
    expect(screen.getByText('冷却中')).toBeTruthy();
    // 失败原因 + 上次成功数据提示
    expect(screen.getByText(/Codex usage HTTP 401。下方为/u)).toBeTruthy();
    // 顶部汇总
    expect(screen.queryByText(/每 5 分钟自动采集/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看说明' }));
    expect(screen.getByText(/每 5 分钟自动采集/u)).toBeTruthy();
    expect(screen.getByText(/1 个异常/u)).toBeTruthy();
    expect(screen.getByText(/1 个需关注/u)).toBeTruthy();
    // 24h 变化来自 history 的最早成功点
    expect(screen.getByText(/24h \+4\.1%/u)).toBeTruthy();
    // 火山口径脚注
    expect(screen.queryByText(/不计入 5 小时 \/ 周额度限制/u)).toBeNull();
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

  it.each([0, '0', '0.00', undefined])('Credits 为 %s 时不显示占位', async (balance) => {
    api.providerQuota.mockResolvedValue({ ...overview, items: [{ ...overview.items[1], extra: { credits: { balance } } }] });
    render(<ProviderQuotaPage />);
    const card = await screen.findByTestId('quota-account-codex:c1');
    expect(within(card).queryByText(/Credits/)).toBeNull();
  });

  it.each([2.5, '12', -1])('非零 Credits %s 紧接套餐标签展示', async (balance) => {
    api.providerQuota.mockResolvedValue({ ...overview, items: [{ ...overview.items[1], extra: { credits: { balance } } }] });
    render(<ProviderQuotaPage />);
    const badge = await screen.findByText('Codex 订阅 · Pro · 重置券 2');
    expect(within(badge.parentElement!).getByText(`Credits ${balance}`)).toBeTruthy();
  });

  it('Claude 订阅是推送型来源：正常渲染额度，但不给单账号刷新按钮', async () => {
    const claude = {
      sourceKind: 'claude_subscription' as const,
      accountKey: 'claude:kaiyankeji.5@gmail.com',
      accountLabel: 'kaiyankeji.5@gmail.com',
      windows: [
        { id: 'five_hour', label: '5 小时', windowSeconds: 18_000, usedPercent: 22, resetAt: '2026-09-05T11:20:00.000Z' },
        { id: 'seven_day', label: '7 天', windowSeconds: 604_800, usedPercent: 37, resetAt: '2026-09-11T00:00:00.000Z' },
      ],
      limitReached: false,
      ok: true,
      collectedAt: '2026-09-05T06:28:00.000Z',
    };
    api.providerQuota.mockResolvedValue({ ...overview, items: [...overview.items, claude] });
    render(<ProviderQuotaPage />);
    await waitFor(() =>
      expect(screen.getByTestId('quota-account-claude:kaiyankeji.5@gmail.com')).toBeTruthy(),
    );
    expect(screen.getByText('Claude 订阅')).toBeTruthy();
    expect(screen.getByText('37.0%')).toBeTruthy();
    expect(screen.getByText('22.0%')).toBeTruthy();
    // 平台无法主动向 Anthropic 取数，单卡刷新按钮必须不存在（其他账号的仍在）。
    expect(screen.queryByRole('button', { name: '刷新 kaiyankeji.5@gmail.com' })).toBeNull();
    expect(screen.getByRole('button', { name: '刷新 kaiyankeji.3@gmail.com' })).toBeTruthy();
  });

  it('Codex 周额度优先，附加模型默认折叠且不把账号标记为耗尽', async () => {
    const codex = {
      ...overview.items[1]!, ok: true, error: undefined, limitReached: false,
      credential: { availability: 'available' as const },
      windows: [
        { id: 'primary', label: '5 小时', usedPercent: 10, windowSeconds: 18000 },
        { id: 'secondary', label: '每周', usedPercent: 20, windowSeconds: 604800 },
        { id: 'mini:primary', label: 'Mini · 每周', usedPercent: 100, limitReached: true },
      ],
    };
    api.providerQuota.mockResolvedValue({ ...overview, items: [codex], collector: { ...overview.collector, lastRunAt: null } });
    render(<ProviderQuotaPage />);
    await waitFor(() => expect(screen.getByText('正常')).toBeTruthy());
    const windows = screen.getAllByRole('progressbar');
    expect(windows[0]?.getAttribute('aria-label')).toBe('周用量 已用');
    const summary = screen.getByText(/其他模型额度/u);
    expect(summary.closest('details')?.open).toBe(false);
    expect(screen.getByText('1 个窗口已耗尽')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看说明' }));
    expect(screen.getByText(/页面不自动刷新/u)).toBeTruthy();
    expect(screen.queryByText('可用')).toBeNull();
    expect(screen.queryByText('已耗尽')).toBeNull();
  });

  it('单个主额度占满一行、显示已用量，采集时间放在标题区', async () => {
    render(<ProviderQuotaPage />);
    const card = await screen.findByTestId('quota-account-codex:c1');
    const tile = screen.getByTestId('quota-window-primary');
    expect(tile.parentElement?.className).not.toContain('sm:grid-cols-2');
    expect(tile.textContent).toContain('100.0%');
    expect(tile.textContent).toContain('周用量');
    expect(screen.queryByText('供应商仅提供百分比')).toBeNull();
    expect(tile.textContent).not.toContain('剩余');
    const timestamp = [...card.querySelectorAll('span')].find(el => el.textContent?.startsWith('采集失败于'));
    expect(timestamp?.parentElement?.querySelector('button')?.getAttribute('aria-label')).toContain('刷新');
  });

  it('零重置券隐藏，火山套餐信息与到期时间使用相同布局', async () => {
    api.providerQuota.mockResolvedValue({ ...overview, items: overview.items.map(item => ({ ...item, resetCredits: 0 })) });
    render(<ProviderQuotaPage />);
    await screen.findByText('Codex 订阅 · Pro');
    expect(screen.queryByText(/重置券 0/)).toBeNull();
    expect(screen.getByText('火山 Agent Plan · Max')).toBeTruthy();
    const expiry = screen.getByText(/^套餐到期 /);
    expect(expiry.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(expiry.parentElement?.className).toContain('sm:col-start-2');
    expect(expiry.parentElement?.className).toContain('text-xs');
    expect(screen.queryByText('套餐状态')).toBeNull();
  });

  it.each([90, 100])('附加模型已用 %s%% 不影响账号与顶部告警', async (usedPercent) => {
    const item = {
      ...overview.items[1]!, ok: true, error: undefined, limitReached: false,
      credential: { availability: 'available' as const },
      windows: [
        { id: 'primary', label: '每周', usedPercent: 20 },
        { id: 'mini:primary', label: 'Mini · 每周', usedPercent, limitReached: usedPercent >= 100 },
      ],
    };
    api.providerQuota.mockResolvedValue({ ...overview, items: [item] });
    render(<ProviderQuotaPage />);
    await screen.findByText('正常');
    expect(screen.queryByText(/个异常|个需关注/)).toBeNull();
    expect(screen.getByTestId('quota-window-primary').textContent).not.toMatch(/接近上限|已撞限/);
    expect(screen.queryByText('已耗尽')).toBeNull();
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

  it('重置时间在月日与时间之间显示星期', () => {
    expect(formatResetTime('2026-09-10T12:00:00')).toMatch(/09\/10 周四 12:00/);
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
